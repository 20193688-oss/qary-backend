import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PayoutScheduleService } from '../../kopera/services/payout-schedule.js';

export async function registerPayoutScheduleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PayoutScheduleService(prisma);

  const createSchema = z.object({
    recipientName: z.string().min(1),
    recipientAccount: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    frequency: z.string().min(1),
  });

  const serialize = (s: any) => ({
    ...s,
    amount: s.amount?.toString(),
    totalPaid: s.totalPaid?.toString(),
  });

  app.get('/api/payout-schedules/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPayoutAnalytics(req.auth!.userId);
  });

  app.get('/api/payout-schedules/list', { preHandler: [app.requireAuth] }, async (req) => {
    const schedules = await svc.getSchedules(req.auth!.userId);
    return (schedules as any[]).map(serialize);
  });

  app.post('/api/payout-schedules/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const s = await svc.createSchedule(req.auth!.userId, data);
    reply.status(201);
    return serialize(s);
  });

  app.post('/api/payout-schedules/:id/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.executePayout(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'schedule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'schedule_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payout-schedules/:id/pause', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.pauseSchedule(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'schedule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'schedule_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payout-schedules/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.resumeSchedule(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'schedule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'schedule_not_paused') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payout-schedules/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.cancelSchedule(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'schedule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'schedule_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payout-schedules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.getSchedule(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'schedule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
