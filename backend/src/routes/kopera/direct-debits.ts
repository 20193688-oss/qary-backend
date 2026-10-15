import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { DirectDebitService } from '../../kopera/services/direct-debit.js';

export async function registerDirectDebitRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new DirectDebitService(prisma);

  const createSchema = z.object({
    creditorName: z.string().min(1),
    creditorAccount: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    description: z.string().optional(),
  });

  const serialize = (m: any) => ({
    ...m,
    amount: m.amount?.toString(),
    totalCollected: m.totalCollected?.toString(),
  });

  app.get('/api/direct-debits/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getMandateAnalytics(req.auth!.userId);
  });

  app.get('/api/direct-debits/list', { preHandler: [app.requireAuth] }, async (req) => {
    const mandates = await svc.getMandates(req.auth!.userId);
    return (mandates as any[]).map(serialize);
  });

  app.post('/api/direct-debits/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const mandate = await svc.createMandate(req.auth!.userId, data);
    reply.status(201);
    return serialize(mandate);
  });

  app.post('/api/direct-debits/:id/collect', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const mandate = await svc.collectPayment(req.auth!.userId, id);
      return serialize(mandate);
    } catch (e: any) {
      if (e.message === 'mandate_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'mandate_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/direct-debits/:id/suspend', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const mandate = await svc.suspendMandate(req.auth!.userId, id);
      return serialize(mandate);
    } catch (e: any) {
      if (e.message === 'mandate_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'mandate_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/direct-debits/:id/reactivate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const mandate = await svc.reactivateMandate(req.auth!.userId, id);
      return serialize(mandate);
    } catch (e: any) {
      if (e.message === 'mandate_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'mandate_not_suspended') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/direct-debits/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const mandate = await svc.cancelMandate(req.auth!.userId, id);
      return serialize(mandate);
    } catch (e: any) {
      if (e.message === 'mandate_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'mandate_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/direct-debits/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const mandate = await svc.getMandate(req.auth!.userId, id);
      return serialize(mandate);
    } catch (e: any) {
      if (e.message === 'mandate_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
