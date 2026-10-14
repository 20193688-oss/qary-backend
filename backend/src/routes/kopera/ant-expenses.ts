import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AntExpenseService } from '../../kopera/services/ant-expenses.js';
import { audit } from '../../lib/audit.js';

function serialize(e: any) {
  return {
    id: e.id,
    category: e.category,
    merchantName: e.merchantName,
    amount: e.amount?.toString(),
    currency: e.currency,
    frequency: e.frequency,
    monthlyTotal: e.monthlyTotal?.toString(),
    yearlyProjection: e.yearlyProjection?.toString(),
    suggestion: e.suggestion,
    savingsIfCut: e.savingsIfCut?.toString() ?? null,
    isActive: e.isActive,
    detectedAt: e.detectedAt,
  };
}

export async function registerAntExpenseRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new AntExpenseService(prisma);

  app.post('/api/ant-expenses', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      category: z.string().min(1),
      merchantName: z.string().min(1),
      amount: z.number().positive(),
      currency: z.string().length(3),
      frequency: z.enum(['daily', 'weekly', 'monthly']),
      monthlyTotal: z.number().positive(),
      yearlyProjection: z.number().positive(),
      suggestion: z.string().optional(),
      savingsIfCut: z.number().positive().optional(),
    }).parse(req.body);

    try {
      const expense = await svc.detect(req.auth!.userId, {
        ...body,
        amount: BigInt(Math.round(body.amount * 100)),
        currency: body.currency.toUpperCase(),
        monthlyTotal: BigInt(Math.round(body.monthlyTotal * 100)),
        yearlyProjection: BigInt(Math.round(body.yearlyProjection * 100)),
        savingsIfCut: body.savingsIfCut ? BigInt(Math.round(body.savingsIfCut * 100)) : undefined,
      });
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'system', eventType: 'ant_expense.detected',
        payload: { category: body.category, merchantName: body.merchantName },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(201).send(serialize(expense));
    } catch (err: any) {
      if (err.message === 'expense_already_tracked') return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/ant-expenses', { preHandler: [app.requireAuth] }, async (req) => {
    const expenses = await svc.listActive(req.auth!.userId);
    return expenses.map(serialize);
  });

  app.get('/api/ant-expenses/dismissed', { preHandler: [app.requireAuth] }, async (req) => {
    const expenses = await svc.listDismissed(req.auth!.userId);
    return expenses.map(serialize);
  });

  app.get('/api/ant-expenses/summary/:currency', { preHandler: [app.requireAuth] }, async (req) => {
    const { currency } = req.params as { currency: string };
    const summary = await svc.getSummary(req.auth!.userId, currency);
    return {
      currency: summary.currency,
      count: summary.count,
      totalMonthly: summary.totalMonthly.toString(),
      totalYearly: summary.totalYearly.toString(),
      totalSavingsIfCut: summary.totalSavingsIfCut.toString(),
    };
  });

  app.get('/api/ant-expenses/breakdown/:currency', { preHandler: [app.requireAuth] }, async (req) => {
    const { currency } = req.params as { currency: string };
    const breakdown = await svc.getCategoryBreakdown(req.auth!.userId, currency);
    return breakdown.map((b) => ({
      category: b.category,
      count: b.count,
      monthlyTotal: b.monthlyTotal.toString(),
      yearlyProjection: b.yearlyProjection.toString(),
    }));
  });

  app.get('/api/ant-expenses/savings-impact', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getSavingsImpactReport(req.auth!.userId);
    const byCurrency: Record<string, any> = {};
    for (const [cur, data] of Object.entries(result.byCurrency)) {
      byCurrency[cur] = {
        monthlyTotal: data.monthlyTotal.toString(),
        potentialSavings: data.potentialSavings.toString(),
        count: data.count,
      };
    }
    return {
      totalTracked: result.totalTracked,
      activeCount: result.activeCount,
      dismissedCount: result.dismissedCount,
      byCurrency,
      highestImpact: result.highestImpact ? { ...result.highestImpact, savingsIfCut: result.highestImpact.savingsIfCut.toString() } : null,
    };
  });

  app.get('/api/ant-expenses/trend-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getTrendAnalysis(req.auth!.userId);
    const byFrequency: Record<string, any> = {};
    for (const [freq, data] of Object.entries(result.byFrequency)) {
      byFrequency[freq] = { count: data.count, totalMonthly: data.totalMonthly.toString() };
    }
    return {
      totalExpenses: result.totalExpenses,
      activeCount: result.activeCount,
      dismissedCount: result.dismissedCount,
      totalActiveMonthly: result.totalActiveMonthly.toString(),
      totalDismissedMonthly: result.totalDismissedMonthly.toString(),
      avgPerExpense: result.avgPerExpense.toString(),
      byFrequency,
      topMerchants: result.topMerchants.map((m) => ({
        ...m,
        monthlyTotal: m.monthlyTotal.toString(),
      })),
    };
  });

  app.get('/api/ant-expenses/merchant-concentration', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getMerchantConcentration(req.auth!.userId);
  });

  app.get('/api/ant-expenses/action-plan', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getActionPlan(req.auth!.userId);
  });

  app.get('/api/ant-expenses/category-risk-score', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCategoryRiskScore(req.auth!.userId);
  });

  app.get('/api/ant-expenses/seasonal-pattern', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSeasonalPattern(req.auth!.userId);
  });

  app.get('/api/ant-expenses/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const expense = await svc.getById(id);
    if (!expense || expense.userId !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return serialize(expense);
  });

  app.post('/api/ant-expenses/:id/reactivate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const expense = await svc.reactivate(id, req.auth!.userId);
      return serialize(expense);
    } catch (err: any) {
      if (err.message === 'expense_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_active') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/ant-expenses/:id/dismiss', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const expense = await svc.dismiss(id, req.auth!.userId);
      return serialize(expense);
    } catch (err: any) {
      if (err.message === 'expense_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_dismissed') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
