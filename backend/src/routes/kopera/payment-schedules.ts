import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentScheduleService } from '../../kopera/services/payment-schedule.js';

export async function registerPaymentScheduleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentScheduleService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    recipientName: z.string().min(1),
    recipientAccount: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    startDate: z.string().datetime(),
    installments: z.number().int().positive(),
  });

  const serialize = (s: any) => ({
    ...s,
    amount: s.amount?.toString(),
    totalPaid: s.totalPaid?.toString(),
  });

  app.get('/api/payment-schedules/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getScheduleAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-schedules/list', { preHandler: [app.requireAuth] }, async (req) => {
    const schedules = await svc.getSchedules(req.auth!.userId);
    return (schedules as any[]).map(serialize);
  });

  app.post('/api/payment-schedules/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const s = await svc.createSchedule(req.auth!.userId, {
      ...data,
      startDate: new Date(data.startDate),
    });
    reply.status(201);
    return serialize(s);
  });

  app.post('/api/payment-schedules/:id/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.executeInstallment(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'schedule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'schedule_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-schedules/:id/pause', { preHandler: [app.requireAuth] }, async (req, reply) => {
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

  app.post('/api/payment-schedules/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
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

  app.post('/api/payment-schedules/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.cancelSchedule(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'schedule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'schedule_already_completed' || e.message === 'schedule_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-schedules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
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
