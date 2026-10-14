import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionService } from '../../kopera/services/transactions.js';

function serialize(t: any) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    amount: t.amount?.toString(),
    currency: t.currency,
    feeAmount: t.feeAmount?.toString(),
    description: t.description,
    reference: t.reference,
    senderWalletId: t.senderWalletId,
    receiverWalletId: t.receiverWalletId,
    counterpartyName: t.counterpartyName,
    paymentMethodUsed: t.paymentMethodUsed,
    createdAt: t.createdAt,
    processedAt: t.processedAt,
  };
}

export async function registerTransactionRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionService(prisma);

  app.get('/api/transaction-history', { preHandler: [app.requireAuth] }, async (req) => {
    const q = z.object({
      type: z.string().optional(),
      status: z.string().optional(),
      currency: z.string().length(3).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);

    const result = await svc.listTransactions(req.auth!.userId, {
      ...q,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return { data: result.rows.map(serialize), total: result.total };
  });

  app.get('/api/transaction-history/search', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const q = z.object({
      q: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);

    const results = await svc.searchTransactions(req.auth!.userId, q.q, { limit: q.limit });
    return results.map(serialize);
  });

  app.get('/api/transaction-history/export', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const q = z.object({
      currency: z.string().length(3).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }).parse(req.query);

    const result = await svc.listTransactions(req.auth!.userId, {
      currency: q.currency,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: 10000,
      offset: 0,
    });

    const header = 'id,type,status,amount,currency,fee,description,reference,date\n';
    const rows = result.rows.map((t: any) =>
      `${t.id},${t.type},${t.status},${t.amount},${t.currency},${t.feeAmount ?? 0},"${(t.description ?? '').replace(/"/g, '""')}",${t.reference ?? ''},${t.createdAt ? new Date(t.createdAt).toISOString() : ''}`,
    ).join('\n');

    return reply
      .header('content-type', 'text/csv')
      .header('content-disposition', 'attachment; filename="transactions.csv"')
      .send(header + rows);
  });

  app.get('/api/transaction-history/monthly/:currency', { preHandler: [app.requireAuth] }, async (req) => {
    const { currency } = req.params as { currency: string };
    const query = req.query as { year?: string };
    const year = Number(query.year ?? new Date().getFullYear());
    const breakdown = await svc.getMonthlyBreakdown(req.auth!.userId, currency, year);
    return breakdown.map((m) => ({
      month: m.month,
      totalIn: m.totalIn.toString(),
      totalOut: m.totalOut.toString(),
      transactionCount: m.transactionCount,
    }));
  });

  app.get('/api/transaction-history/counterparty-report', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getCounterpartyReport(req.auth!.userId);
    return {
      totalCounterparties: result.totalCounterparties,
      totalTransactions: result.totalTransactions,
      topCounterparties: result.topCounterparties.map((c) => ({
        ...c,
        totalSent: c.totalSent.toString(),
        totalReceived: c.totalReceived.toString(),
      })),
    };
  });

  app.get('/api/transaction-history/cash-flow-forecast', { preHandler: [app.requireAuth] }, async (req) => {
    const q = z.object({
      currency: z.string().length(3),
      days: z.coerce.number().int().min(1).max(365).optional(),
    }).parse(req.query);

    const result = await svc.getCashFlowForecast(req.auth!.userId, q.currency, q.days);
    const byType: Record<string, { count: number; total: string; direction: string }> = {};
    for (const [type, data] of Object.entries(result.byType)) {
      byType[type] = { count: data.count, total: data.total.toString(), direction: data.direction };
    }
    return {
      currency: result.currency,
      forecastDays: result.forecastDays,
      historicalDays: result.historicalDays,
      avgDailyInflow: result.avgDailyInflow.toString(),
      avgDailyOutflow: result.avgDailyOutflow.toString(),
      projectedNetFlow: result.projectedNetFlow.toString(),
      confidence: result.confidence,
      byType,
    };
  });

  app.get('/api/transaction-history/velocity', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { currency?: string };
    const result = await svc.getVelocityReport(req.auth!.userId, query.currency);
    return {
      totalTransactions: result.totalTransactions,
      dailyAverage: result.dailyAverage,
      weeklyAverage: result.weeklyAverage,
      peakDay: result.peakDay ? { ...result.peakDay, volume: result.peakDay.volume.toString() } : null,
      largestTransaction: result.largestTransaction ? { ...result.largestTransaction, amount: result.largestTransaction.amount.toString() } : null,
      trendComparison: result.trendComparison,
    };
  });

  app.get('/api/transaction-history/recurring-patterns', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRecurringPatterns(req.auth!.userId);
  });

  app.get('/api/transaction-history/fee-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { currency?: string };
    return svc.getFeeAnalysis(req.auth!.userId, query.currency);
  });

  app.get('/api/transaction-history/distribution', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { currency?: string };
    const dist = await svc.getTypeDistribution(req.auth!.userId, query.currency);
    const byType: Record<string, { count: number; totalAmount: string }> = {};
    for (const [type, data] of Object.entries(dist.byType)) {
      byType[type] = { count: data.count, totalAmount: data.totalAmount.toString() };
    }
    return { totalTransactions: dist.totalTransactions, byType };
  });

  app.get('/api/transaction-history/amount-distribution', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { currency?: string };
    return svc.getAmountDistribution(req.auth!.userId, query.currency);
  });

  app.get('/api/transaction-history/peak-activity', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPeakActivityAnalysis(req.auth!.userId);
  });

  app.get('/api/transaction-history/anomaly-detection', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { currency?: string };
    return svc.getTransactionAnomalyDetection(req.auth!.userId, query.currency);
  });

  app.get('/api/transaction-history/correlation-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { currency?: string };
    return svc.getTransactionCorrelationAnalysis(req.auth!.userId, query.currency);
  });

  app.get('/api/transaction-history/risk-profile', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTransactionRiskProfile(req.auth!.userId);
  });

  app.get('/api/transaction-history/velocity-monitor', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTransactionVelocityMonitor(req.auth!.userId);
  });

  app.get('/api/transaction-history/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const txn = await svc.getTransaction(id, req.auth!.userId);
    if (!txn) return reply.code(404).send({ error: 'not_found' });
    return serialize(txn);
  });

  app.get('/api/transaction-history/reference/:ref', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const txn = await svc.getByReference(ref, req.auth!.userId);
    if (!txn) return reply.code(404).send({ error: 'not_found' });
    return serialize(txn);
  });

  app.get('/api/transaction-history/summary/:currency', { preHandler: [app.requireAuth] }, async (req) => {
    const { currency } = req.params as { currency: string };
    const summary = await svc.getSummary(req.auth!.userId, currency);
    return {
      currency: summary.currency,
      totalIn: summary.totalIn.toString(),
      totalOut: summary.totalOut.toString(),
      count: summary.count,
    };
  });
}
