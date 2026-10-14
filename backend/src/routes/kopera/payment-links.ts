import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentLinkService } from '../../kopera/services/payment-links.js';
import { WalletService } from '../../kopera/services/wallet.js';
import { audit } from '../../lib/audit.js';

function serialize(l: any) {
  return {
    id: l.id,
    code: l.code,
    amount: l.amount.toString(),
    currency: l.currency,
    description: l.description,
    status: l.status,
    singleUse: l.singleUse,
    timesUsed: l.timesUsed,
    lastUsedAt: l.lastUsedAt,
    expiresAt: l.expiresAt,
    createdAt: l.createdAt,
  };
}

export async function registerPaymentLinkRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentLinkService(prisma);
  const walletSvc = new WalletService(prisma);

  app.post('/api/payment-links', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string().length(3),
      description: z.string().max(500).optional(),
      expiresAt: z.string().datetime().optional(),
      singleUse: z.boolean().optional(),
    }).parse(req.body);

    const amountCents = BigInt(Math.round(body.amount * 100));
    const link = await svc.create({
      userId: req.auth!.userId,
      amount: amountCents,
      currency: body.currency,
      description: body.description,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      singleUse: body.singleUse,
    });
    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'payment_link.created',
      payload: { amount: body.amount, currency: body.currency, code: link.code },
      requestId: String(req.id), ip: req.ip,
    });
    return reply.code(201).send(serialize(link));
  });

  app.get('/api/payment-links', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; status?: string };
    const list = await svc.listByUser(req.auth!.userId, {
      status: query.status,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return list.map(serialize);
  });

  app.get('/api/payment-links/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    const analytics = await svc.getAnalytics(req.auth!.userId);
    return {
      totalLinks: analytics.totalLinks,
      totalCollected: analytics.totalCollected.toString(),
      totalTimesUsed: analytics.totalTimesUsed,
      byStatus: analytics.byStatus,
    };
  });

  app.get('/api/payment-links/conversion-report', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getConversionReport(req.auth!.userId);
    return {
      totalLinks: result.totalLinks,
      usedCount: result.usedCount,
      conversionRate: result.conversionRate,
      totalRevenue: result.totalRevenue.toString(),
      avgRevenuePerLink: result.avgRevenuePerLink.toString(),
      topPerformingLink: result.topPerformingLink ? {
        ...result.topPerformingLink,
        amount: result.topPerformingLink.amount.toString(),
      } : null,
    };
  });

  app.get('/api/payment-links/revenue-breakdown', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getRevenueBreakdown(req.auth!.userId);
    return {
      totalLinks: result.totalLinks,
      totalRevenue: result.totalRevenue.toString(),
      byCurrency: result.byCurrency,
      singleUse: { count: result.singleUse.count, revenue: result.singleUse.revenue.toString() },
      multiUse: { count: result.multiUse.count, revenue: result.multiUse.revenue.toString() },
      activeRevenue: result.activeRevenue.toString(),
      expiredRevenue: result.expiredRevenue.toString(),
    };
  });

  app.get('/api/payment-links/lifecycle-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getLifecycleAnalysis(req.auth!.userId);
  });

  app.get('/api/payment-links/amount-tier-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getAmountTierAnalysis(req.auth!.userId);
  });

  app.get('/api/payment-links/expiring', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { days?: string };
    const withinDays = Math.min(Number(query.days ?? 7), 90);
    const results = await svc.getExpiringSoon(req.auth!.userId, withinDays);
    return results.map((l: any) => ({
      ...l,
      amount: l.amount.toString(),
    }));
  });

  app.get('/api/payment-links/usage-velocity', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getUsageVelocity(req.auth!.userId);
  });

  app.get('/api/payment-links/expiration-impact', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getExpirationImpactAnalysis(req.auth!.userId);
  });

  app.get('/api/payment-links/abandonment-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPaymentLinkAbandonmentAnalysis(req.auth!.userId);
  });

  app.get('/api/payment-links/recurrence-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPaymentLinkRecurrenceAnalysis(req.auth!.userId);
  });

  app.get('/api/payment-links/revenue-concentration', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPaymentLinkRevenueConcentration(req.auth!.userId);
  });

  app.get('/api/payment-links/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const link = await svc.getById(id);
    if (!link || link.userId !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return serialize(link);
  });

  app.get('/api/payment-links/code/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const link = await svc.getByCode(code);
    if (!link) return reply.code(404).send({ error: 'not_found' });
    return {
      code: link.code,
      amount: link.amount.toString(),
      currency: link.currency,
      description: link.description,
      status: link.status,
    };
  });

  app.post('/api/payment-links/pay/:code', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { code } = req.params as { code: string };

    const link = await svc.getByCode(code);
    if (!link) return reply.code(404).send({ error: 'link_not_found' });
    if (link.status !== 'active') return reply.code(400).send({ error: 'link_not_active' });
    if (link.userId === req.auth!.userId) return reply.code(400).send({ error: 'cannot_pay_own_link' });

    try {
      const result = await walletSvc.transfer(
        req.auth!.userId, link.userId, link.currency,
        link.amount, `Payment via link ${code}`,
      );

      await svc.markUsed(link.id);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'payment_link.paid',
        payload: { linkId: link.id, code, amount: link.amount.toString(), currency: link.currency },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.send({
        paid: true,
        transactionId: result.transaction.id,
        amount: link.amount.toString(),
        currency: link.currency,
      });
    } catch (err: any) {
      if (err.message === 'insufficient_funds') return reply.code(400).send({ error: err.message });
      if (err.message.includes('not_found')) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/payment-links/:id/deactivate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const link = await svc.deactivate(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'payment_link.deactivated',
        payload: { linkId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(link);
    } catch (err: any) {
      if (err.message === 'link_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_deactivated') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
