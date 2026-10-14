import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { SubscriptionService } from '../../kopera/services/subscriptions.js';
import { audit } from '../../lib/audit.js';

export async function registerSubscriptionRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const subscriptions = new SubscriptionService(prisma);

  app.post('/api/subscriptions', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      planName: z.string().min(1),
      amount: z.number().positive(),
      currency: z.string().length(3),
      interval: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
      intervalCount: z.number().int().min(1).max(12).optional(),
      merchantId: z.string().optional(),
    }).parse(req.body);

    const sub = await subscriptions.create({
      userId: req.auth!.userId,
      planName: body.planName,
      amount: BigInt(Math.round(body.amount * 100)),
      currency: body.currency,
      interval: body.interval,
      intervalCount: body.intervalCount,
      merchantId: body.merchantId,
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'subscription.created',
      payload: { subscriptionId: sub.id, planName: body.planName },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send(serializeSub(sub));
  });

  app.get('/api/subscriptions', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; status?: string };
    const list = await subscriptions.listByUser(req.auth!.userId, {
      status: query.status,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return list.map(serializeSub);
  });

  app.get('/api/subscriptions/summary', { preHandler: [app.requireAuth] }, async (req) => {
    const summary = await subscriptions.getSpendingSummary(req.auth!.userId);
    const monthlyBurn: Record<string, string> = {};
    for (const [cur, amt] of Object.entries(summary.monthlyBurnByCurrency)) {
      monthlyBurn[cur] = amt.toString();
    }
    return {
      activeCount: summary.activeCount,
      byStatus: summary.byStatus,
      monthlyBurnByCurrency: monthlyBurn,
      mostExpensive: summary.mostExpensive
        ? { ...summary.mostExpensive, amount: summary.mostExpensive.amount.toString() }
        : null,
    };
  });

  app.get('/api/subscriptions/upcoming', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { days?: string };
    const days = Math.min(Number(query.days ?? 30), 365);
    const result = await subscriptions.getUpcomingBillings(req.auth!.userId, days);
    return {
      totalDue: result.totalDue.toString(),
      count: result.count,
      billings: result.billings.map((b: any) => ({
        subscriptionId: b.subscriptionId,
        planName: b.planName,
        amount: b.amount.toString(),
        currency: b.currency,
        dueDate: b.dueDate,
      })),
    };
  });

  app.get('/api/subscriptions/cost-optimization', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await subscriptions.getCostOptimization(req.auth!.userId);
    return {
      ...result,
      monthlySpend: result.monthlySpend.toString(),
      pausedMonthlySavings: result.pausedMonthlySavings.toString(),
      pastDueAmount: result.pastDueAmount.toString(),
    };
  });

  app.get('/api/subscriptions/usage-timeline', { preHandler: [app.requireAuth] }, async (req) => {
    return subscriptions.getUsageTimeline(req.auth!.userId);
  });

  app.get('/api/subscriptions/churn-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await subscriptions.getChurnAnalysis(req.auth!.userId);
    return {
      totalSubscriptions: result.totalSubscriptions,
      cancelledCount: result.cancelledCount,
      churnRate: result.churnRate,
      avgLifetimeDays: result.avgLifetimeDays,
      totalSpendBeforeChurn: result.totalSpendBeforeChurn.toString(),
      mostCancelledPlans: result.mostCancelledPlans,
    };
  });

  app.get('/api/subscriptions/billing-health', { preHandler: [app.requireAuth] }, async (req) => {
    return subscriptions.getBillingHealth(req.auth!.userId);
  });

  app.get('/api/subscriptions/renewals', { preHandler: [app.requireAuth] }, async (req) => {
    const countdown = await subscriptions.getRenewalCountdown(req.auth!.userId);
    return countdown.map((r: any) => ({
      subscriptionId: r.subscriptionId,
      planName: r.planName,
      amount: r.amount.toString(),
      currency: r.currency,
      nextBillingDate: r.nextBillingDate,
      daysUntilRenewal: r.daysUntilRenewal,
    }));
  });

  app.get('/api/subscriptions/spending-trend', { preHandler: [app.requireAuth] }, async (req) => {
    return subscriptions.getSpendingTrend(req.auth!.userId);
  });

  app.get('/api/subscriptions/cancellation-risk', { preHandler: [app.requireAuth] }, async (req) => {
    return subscriptions.getCancellationRisk(req.auth!.userId);
  });

  app.get('/api/subscriptions/plan-popularity', { preHandler: [app.requireAuth] }, async (req) => {
    return subscriptions.getPlanPopularity(req.auth!.userId);
  });

  app.get('/api/subscriptions/lifetime-value', { preHandler: [app.requireAuth] }, async (req) => {
    return subscriptions.getSubscriptionLifetimeValue(req.auth!.userId);
  });

  app.get('/api/subscriptions/overlap-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return subscriptions.getSubscriptionOverlapAnalysis(req.auth!.userId);
  });

  app.get('/api/subscriptions/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const sub = await subscriptions.getById(id);
    if (!sub) return reply.code(404).send({ error: 'not_found' });
    if (sub.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return serializeSub(sub);
  });

  app.post('/api/subscriptions/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const sub = await subscriptions.cancel(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'subscription.cancelled',
        payload: { subscriptionId: sub.id },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.send(serializeSub(sub));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'subscription_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'already_cancelled') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/subscriptions/:id/pause', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const sub = await subscriptions.pause(id, req.auth!.userId);
      return reply.send(serializeSub(sub));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'subscription_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'not_active') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/subscriptions/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const sub = await subscriptions.resume(id, req.auth!.userId);
      return reply.send(serializeSub(sub));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'subscription_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'not_paused') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.put('/api/subscriptions/:id/plan', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      planName: z.string().min(1),
      amount: z.number().positive(),
    }).parse(req.body);

    try {
      const sub = await subscriptions.updatePlan(id, req.auth!.userId, body.planName, BigInt(Math.round(body.amount * 100)));

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'subscription.plan_updated',
        payload: { subscriptionId: id, planName: body.planName, amount: body.amount },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.send(serializeSub(sub));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'subscription_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'already_cancelled') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/subscriptions/process-billing', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const result = await subscriptions.processDueBillings();

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'system', eventType: 'subscription.billing_processed',
      payload: { processed: result.processed },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send(result);
  });
}

function serializeSub(s: any) {
  return {
    id: s.id,
    planName: s.planName,
    amount: s.amount.toString(),
    currency: s.currency,
    interval: s.interval,
    intervalCount: s.intervalCount,
    status: s.status,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    nextBillingDate: s.nextBillingDate,
    cancelledAt: s.cancelledAt,
    createdAt: s.createdAt,
  };
}
