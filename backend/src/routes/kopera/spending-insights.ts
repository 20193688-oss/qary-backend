import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { SpendingInsightService } from '../../kopera/services/spending-insight.js';

export async function registerSpendingInsightRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new SpendingInsightService(prisma);

  const createSchema = z.object({
    period: z.string().min(1).max(20),
    category: z.string().min(1).max(100),
    totalSpent: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    transactionCount: z.number().int().min(0),
    averageAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    trend: z.enum(['STABLE', 'INCREASING', 'DECREASING']).optional(),
    recommendation: z.string().max(500).optional(),
  });

  const serialize = (i: any) => ({
    ...i,
    totalSpent: i.totalSpent?.toString(),
    averageAmount: i.averageAmount?.toString(),
  });

  app.get('/api/spending-insights/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getInsightAnalytics(req.auth!.userId);
  });

  app.get('/api/spending-insights/list', { preHandler: [app.requireAuth] }, async (req) => {
    const insights = await svc.getInsights(req.auth!.userId);
    return (insights as any[]).map(serialize);
  });

  app.post('/api/spending-insights/generate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const insight = await svc.generateInsight(req.auth!.userId, data);
    reply.status(201);
    return serialize(insight);
  });

  app.get('/api/spending-insights/period/:period', { preHandler: [app.requireAuth] }, async (req) => {
    const { period } = req.params as { period: string };
    const insights = await svc.getByPeriod(req.auth!.userId, period);
    return (insights as any[]).map(serialize);
  });

  app.get('/api/spending-insights/category/:category', { preHandler: [app.requireAuth] }, async (req) => {
    const { category } = req.params as { category: string };
    const insights = await svc.getByCategory(req.auth!.userId, category);
    return (insights as any[]).map(serialize);
  });

  app.delete('/api/spending-insights/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const insight = await svc.deleteInsight(req.auth!.userId, id);
      return serialize(insight);
    } catch (e: any) {
      if (e.message === 'insight_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/spending-insights/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const insight = await svc.getInsight(req.auth!.userId, id);
      return serialize(insight);
    } catch (e: any) {
      if (e.message === 'insight_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
