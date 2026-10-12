import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PointsService } from '../../kopera/services/points.js';

export async function registerPointsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const points = new PointsService(prisma);

  app.get('/api/points', { preHandler: [app.requireAuth] }, async (req) => {
    return points.getBalance(req.auth!.userId);
  });

  app.get('/api/points/history', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string };
    return points.getHistory(
      req.auth!.userId,
      Math.min(Number(query.limit ?? 20), 100),
      Number(query.offset ?? 0),
    );
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
