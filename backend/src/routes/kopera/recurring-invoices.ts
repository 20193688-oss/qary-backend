import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { RecurringInvoiceService } from '../../kopera/services/recurring-invoice.js';

export async function registerRecurringInvoiceRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new RecurringInvoiceService(prisma);

  const createSchema = z.object({
    recipientName: z.string().min(1),
    recipientEmail: z.string().email(),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    interval: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    description: z.string().optional(),
    startDate: z.string().transform((v) => new Date(v)),
  });

  const serialize = (r: any) => ({ ...r, amount: r.amount?.toString() });

  app.get('/api/recurring-invoices/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRecurringAnalytics(req.auth!.userId);
  });

  app.get('/api/recurring-invoices/list', { preHandler: [app.requireAuth] }, async (req) => {
    const recs = await svc.getRecurrings(req.auth!.userId);
    return (recs as any[]).map(serialize);
  });

  app.post('/api/recurring-invoices/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const rec = await svc.createRecurring(req.auth!.userId, data);
    reply.status(201);
    return serialize(rec);
  });

  app.post('/api/recurring-invoices/:id/issue', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const rec = await svc.issueNext(req.auth!.userId, id);
      return serialize(rec);
    } catch (e: any) {
      if (e.message === 'recurring_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'recurring_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/recurring-invoices/:id/pause', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const rec = await svc.pauseRecurring(req.auth!.userId, id);
      return serialize(rec);
    } catch (e: any) {
      if (e.message === 'recurring_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'recurring_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/recurring-invoices/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const rec = await svc.resumeRecurring(req.auth!.userId, id);
      return serialize(rec);
    } catch (e: any) {
      if (e.message === 'recurring_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'recurring_not_paused') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/recurring-invoices/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const rec = await svc.cancelRecurring(req.auth!.userId, id);
      return serialize(rec);
    } catch (e: any) {
      if (e.message === 'recurring_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'recurring_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/recurring-invoices/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const rec = await svc.getRecurring(req.auth!.userId, id);
      return serialize(rec);
    } catch (e: any) {
      if (e.message === 'recurring_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
