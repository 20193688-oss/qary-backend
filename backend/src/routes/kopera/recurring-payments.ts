import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { RecurringPaymentService } from '../../kopera/services/recurring-payment.js';

export async function registerRecurringPaymentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new RecurringPaymentService(prisma);

  const createSchema = z.object({
    recipientName: z.string().min(1),
    recipientAccount: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    frequency: z.string().min(1),
    description: z.string().optional(),
  });

  const serialize = (r: any) => ({
    ...r,
    amount: r.amount?.toString(),
    totalPaid: r.totalPaid?.toString(),
  });

  app.get('/api/recurring-payments/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRecurringAnalytics(req.auth!.userId);
  });

  app.get('/api/recurring-payments/list', { preHandler: [app.requireAuth] }, async (req) => {
    const payments = await svc.getRecurrings(req.auth!.userId);
    return (payments as any[]).map(serialize);
  });

  app.post('/api/recurring-payments/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createRecurring(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/recurring-payments/:id/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.executePayment(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'recurring_payment_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'payment_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/recurring-payments/:id/pause', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.pausePayment(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'recurring_payment_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'payment_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/recurring-payments/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.resumePayment(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'recurring_payment_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'payment_not_paused') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/recurring-payments/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.cancelPayment(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'recurring_payment_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'payment_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/recurring-payments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getRecurring(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'recurring_payment_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
