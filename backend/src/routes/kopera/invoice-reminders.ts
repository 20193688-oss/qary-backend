import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { InvoiceReminderService } from '../../kopera/services/invoice-reminder.js';

export async function registerInvoiceReminderRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new InvoiceReminderService(prisma);

  const createSchema = z.object({
    invoiceId: z.string().min(1),
    recipientEmail: z.string().email(),
    message: z.string().min(1),
    sendAt: z.string().transform((v) => new Date(v)),
  });

  const serialize = (r: any) => ({ ...r });

  app.get('/api/invoice-reminders/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getReminderAnalytics(req.auth!.userId);
  });

  app.get('/api/invoice-reminders/list', { preHandler: [app.requireAuth] }, async (req) => {
    const reminders = await svc.getReminders(req.auth!.userId);
    return (reminders as any[]).map(serialize);
  });

  app.post('/api/invoice-reminders/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createReminder(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/invoice-reminders/:id/send', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.sendReminder(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'reminder_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'reminder_not_scheduled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/invoice-reminders/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.cancelReminder(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'reminder_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'reminder_not_scheduled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/invoice-reminders/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getReminder(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'reminder_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
