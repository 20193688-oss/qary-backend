import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionLimitService } from '../../kopera/services/transaction-limits.js';
import { audit } from '../../lib/audit.js';

function serialize(l: any) {
  return {
    id: l.id,
    currency: l.currency,
    limitType: l.limitType,
    maxAmount: l.maxAmount.toString(),
    currentUsage: l.currentUsage.toString(),
    remaining: (l.maxAmount - l.currentUsage).toString(),
    periodStart: l.periodStart,
    createdAt: l.createdAt,
  };
}

export async function registerTransactionLimitRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionLimitService(prisma);

  app.post('/api/transaction-limits', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      currency: z.string().length(3),
      limitType: z.enum(['daily', 'monthly']),
      maxAmount: z.number().positive(),
    }).parse(req.body);

    const maxCents = BigInt(Math.round(body.maxAmount * 100));
    const limit = await svc.setLimit({
      userId: req.auth!.userId,
      currency: body.currency,
      limitType: body.limitType,
      maxAmount: maxCents,
    });
    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'transaction_limit.set',
      payload: { currency: body.currency, limitType: body.limitType, maxAmount: body.maxAmount },
      requestId: String(req.id), ip: req.ip,
    });
    return reply.code(200).send(serialize(limit));
  });

  app.get('/api/transaction-limits', { preHandler: [app.requireAuth] }, async (req) => {
    const limits = await svc.getLimits(req.auth!.userId);
    return limits.map(serialize);
  });

  app.get('/api/transaction-limits/usage-summary', { preHandler: [app.requireAuth] }, async (req) => {
    const summary = await svc.getUsageSummary(req.auth!.userId);
    return {
      totalLimits: summary.totalLimits,
      byType: summary.byType,
      totalMaxAmount: summary.totalMaxAmount.toString(),
      totalCurrentUsage: summary.totalCurrentUsage.toString(),
      utilizationPercent: summary.utilizationPercent,
    };
  });

  app.get('/api/transaction-limits/utilization-report', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getUtilizationReport(req.auth!.userId);
    return {
      totalLimits: result.totalLimits,
      nearLimitCount: result.nearLimitCount,
      details: result.details.map((d: any) => ({
        ...d,
        maxAmount: d.maxAmount.toString(),
        currentUsage: d.currentUsage.toString(),
        headroom: d.headroom.toString(),
      })),
    };
  });

  app.get('/api/transaction-limits/health-check', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getLimitHealthCheck(req.auth!.userId);
    return {
      totalLimits: result.totalLimits,
      overallHealth: result.overallHealth,
      criticalCount: result.criticalCount,
      warningCount: result.warningCount,
      healthyCount: result.healthyCount,
      underutilizedCount: result.underutilizedCount,
      recommendations: result.recommendations,
      details: result.details.map((d: any) => ({
        ...d,
        maxAmount: d.maxAmount.toString(),
        currentUsage: d.currentUsage.toString(),
        headroom: d.headroom.toString(),
      })),
    };
  });

  app.get('/api/transaction-limits/spending-velocity', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSpendingVelocity(req.auth!.userId);
  });

  app.get('/api/transaction-limits/currency-breakdown', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCurrencyBreakdown(req.auth!.userId);
  });

  app.get('/api/transaction-limits/exhaustion-forecast', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getLimitExhaustionForecast(req.auth!.userId);
  });

  app.get('/api/transaction-limits/compliance-report', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getLimitComplianceReport(req.auth!.userId);
  });

  app.get('/api/transaction-limits/:currency/:limitType', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { currency, limitType } = req.params as { currency: string; limitType: string };
    const limit = await svc.getLimit(req.auth!.userId, currency, limitType);
    if (!limit) return reply.code(404).send({ error: 'limit_not_found' });
    return serialize(limit);
  });

  app.post('/api/transaction-limits/check', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      currency: z.string().length(3),
      amount: z.number().positive(),
    }).parse(req.body);

    const amountCents = BigInt(Math.round(body.amount * 100));
    return svc.checkAndIncrement(req.auth!.userId, body.currency, amountCents);
  });

  app.post('/api/transaction-limits/check-available', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      currency: z.string().length(3),
      amount: z.number().positive(),
    }).parse(req.body);

    const amountCents = BigInt(Math.round(body.amount * 100));
    return svc.checkAvailable(req.auth!.userId, body.currency, amountCents);
  });

  app.delete('/api/transaction-limits/:currency/:limitType', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { currency, limitType } = req.params as { currency: string; limitType: string };
    try {
      await svc.removeLimit(req.auth!.userId, currency, limitType);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'transaction_limit.removed',
        payload: { currency, limitType },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(204).send();
    } catch (err: any) {
      if (err.message === 'limit_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });
}
