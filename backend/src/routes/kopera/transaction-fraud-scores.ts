import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionFraudScoreService } from '../../kopera/services/transaction-fraud-score.js';

export async function registerTransactionFraudScoreRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionFraudScoreService(prisma);

  const createSchema = z.object({
    transactionId: z.string().min(1),
    score: z.number().min(0).max(100),
    riskLevel: z.string().min(1),
    factors: z.string().min(1),
    model: z.string().min(1),
  });

  const reviewSchema = z.object({
    decision: z.string().min(1),
    reviewedBy: z.string().min(1),
  });

  app.get('/api/transaction-fraud-scores/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getScoreAnalytics(req.auth!.userId);
  });

  app.get('/api/transaction-fraud-scores/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getScores(req.auth!.userId);
  });

  app.post('/api/transaction-fraud-scores/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const s = await svc.createScore(req.auth!.userId, data);
    reply.status(201);
    return s;
  });

  app.post('/api/transaction-fraud-scores/:id/review', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = reviewSchema.parse(req.body);
    try {
      return await svc.reviewScore(req.auth!.userId, id, data);
    } catch (e: any) {
      if (e.message === 'score_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'score_already_reviewed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-fraud-scores/:id/escalate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.escalateScore(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'score_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'score_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/transaction-fraud-scores/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getScore(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'score_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
