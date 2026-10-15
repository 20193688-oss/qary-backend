import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { RewardProgramService } from '../../kopera/services/reward-program.js';

export async function registerRewardProgramRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new RewardProgramService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    programType: z.string().min(1),
    pointsPerUnit: z.number().int().positive(),
    currency: z.string().length(3),
    description: z.string().optional(),
  });

  const serialize = (p: any) => ({ ...p });

  app.get('/api/reward-programs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRewardAnalytics(req.auth!.userId);
  });

  app.get('/api/reward-programs/list', { preHandler: [app.requireAuth] }, async (req) => {
    const programs = await svc.getPrograms(req.auth!.userId);
    return (programs as any[]).map(serialize);
  });

  app.post('/api/reward-programs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const p = await svc.createProgram(req.auth!.userId, data);
      reply.status(201);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'reward_program_exists') { reply.status(409); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/reward-programs/:id/issue-points', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { points } = z.object({ points: z.number().int().positive() }).parse(req.body);
    try {
      const p = await svc.issuePoints(req.auth!.userId, id, points);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'reward_program_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'program_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/reward-programs/:id/redeem-points', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { points } = z.object({ points: z.number().int().positive() }).parse(req.body);
    try {
      const p = await svc.redeemPoints(req.auth!.userId, id, points);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'reward_program_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'program_not_active') { reply.status(400); return { error: e.message }; }
      if (e.message === 'insufficient_points') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/reward-programs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const p = await svc.toggleProgram(req.auth!.userId, id, active);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'reward_program_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/reward-programs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const p = await svc.deleteProgram(req.auth!.userId, id);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'reward_program_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/reward-programs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const p = await svc.getProgram(req.auth!.userId, id);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'reward_program_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
