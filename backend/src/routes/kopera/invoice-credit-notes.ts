import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { InvoiceCreditNoteService } from '../../kopera/services/invoice-credit-note.js';

export async function registerInvoiceCreditNoteRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new InvoiceCreditNoteService(prisma);

  const createSchema = z.object({
    invoiceId: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    reason: z.string().min(1),
  });

  const serialize = (cn: any) => ({
    ...cn,
    amount: cn.amount?.toString(),
  });

  app.get('/api/invoice-credit-notes/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCreditNoteAnalytics(req.auth!.userId);
  });

  app.get('/api/invoice-credit-notes/list', { preHandler: [app.requireAuth] }, async (req) => {
    const notes = await svc.getCreditNotes(req.auth!.userId);
    return (notes as any[]).map(serialize);
  });

  app.post('/api/invoice-credit-notes/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const cn = await svc.createCreditNote(req.auth!.userId, data);
    reply.status(201);
    return serialize(cn);
  });

  app.post('/api/invoice-credit-notes/:id/apply', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cn = await svc.applyCreditNote(req.auth!.userId, id);
      return serialize(cn);
    } catch (e: any) {
      if (e.message === 'credit_note_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'credit_note_not_issued') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/invoice-credit-notes/:id/void', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cn = await svc.voidCreditNote(req.auth!.userId, id);
      return serialize(cn);
    } catch (e: any) {
      if (e.message === 'credit_note_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'credit_note_already_voided') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/invoice-credit-notes/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cn = await svc.getCreditNote(req.auth!.userId, id);
      return serialize(cn);
    } catch (e: any) {
      if (e.message === 'credit_note_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
