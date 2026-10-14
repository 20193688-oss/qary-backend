import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PointsService } from '../../kopera/services/points.js';

export async function registerPointsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const points = new PointsService(prisma);

  app.get('/api/points', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getBalance(req.auth!.userId);
  });

  app.get('/api/points/leaderboard', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string };
    return points.leaderboard(Math.min(Number(query.limit ?? 10), 50));
  });

  app.get('/api/points/calculate', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { amount?: string; type?: string };
    const amount = Number(query.amount ?? 0);
    const type = query.type ?? 'PAYMENT';
    const balance = await points.getBalance(req.auth!.userId);
    const pointsToEarn = points.pointsForTransaction(Math.round(amount * 100), type, balance.tier);
    return { pointsToEarn, currentTier: balance.tier, type };
  });

  app.get('/api/points/earning-summary', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getEarningSummary(req.auth!.userId);
  });

  app.get('/api/points/tier-progress', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getTierProgress(req.auth!.userId);
  });

  app.get('/api/points/redemption-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getRedemptionAnalysis(req.auth!.userId);
  });

  app.get('/api/points/engagement-score', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getEngagementScore(req.auth!.userId);
  });

  app.get('/api/points/decay-risk', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getPointsDecayRisk(req.auth!.userId);
  });

  app.get('/api/points/reward-velocity', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getRewardVelocity(req.auth!.userId);
  });

  app.get('/api/points/history', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; type?: string };
    return points.getHistory(req.auth!.userId, {
      type: query.type,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
  });

  app.post('/api/points/earn', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      userId: z.string().min(1),
      amount: z.number().int().positive(),
      reason: z.string().min(1),
      referenceId: z.string().optional(),
    }).parse(req.body);

    const result = await points.earn(body.userId, body.amount, body.reason, body.referenceId);
    return reply.code(201).send({
      userId: body.userId,
      balance: result.balance,
      tier: result.tier,
      earned: body.amount,
    });
  });

  app.post('/api/points/redeem', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().int().positive(),
      reason: z.string().min(1),
    }).parse(req.body);

    try {
      const result = await points.redeem(req.auth!.userId, body.amount, body.reason);
      return reply.send({
        balance: result.balance,
        tier: result.tier,
        redeemed: body.amount,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'insufficient_points') {
        return reply.code(400).send({ error: 'insufficient_points' });
      }
      throw err;
    }
  });
}
