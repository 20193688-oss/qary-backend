import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ChargebackService } from '../../kopera/services/chargeback.js';

export async function registerChargebackRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ChargebackService(prisma);

  const fileSchema = z.object({
    transactionRef: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    reason: z.string().min(1),
    cardLast4: z.string().length(4),
  });

  const serialize = (cb: any) => ({
    ...cb,
    amount: cb.amount?.toString(),
  });

  app.get('/api/chargebacks/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getChargebackAnalytics(req.auth!.userId);
  });

  app.get('/api/chargebacks/list', { preHandler: [app.requireAuth] }, async (req) => {
    const chargebacks = await svc.getChargebacks(req.auth!.userId);
    return (chargebacks as any[]).map(serialize);
  });

  app.post('/api/chargebacks/file', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = fileSchema.parse(req.body);
    const cb = await svc.fileChargeback(req.auth!.userId, data);
    reply.status(201);
    return serialize(cb);
  });

  app.post('/api/chargebacks/:id/evidence', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { evidence } = z.object({ evidence: z.string().min(1) }).parse(req.body);
    try {
      const cb = await svc.submitEvidence(req.auth!.userId, id, evidence);
      return serialize(cb);
    } catch (e: any) {
      if (e.message === 'chargeback_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'chargeback_not_filed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/chargebacks/:id/resolve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { outcome } = z.object({ outcome: z.enum(['WON', 'LOST']) }).parse(req.body);
    try {
      const cb = await svc.resolveChargeback(req.auth!.userId, id, outcome);
      return serialize(cb);
    } catch (e: any) {
      if (e.message === 'chargeback_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'chargeback_not_resolvable') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/chargebacks/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cb = await svc.cancelChargeback(req.auth!.userId, id);
      return serialize(cb);
    } catch (e: any) {
      if (e.message === 'chargeback_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'chargeback_not_filed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/chargebacks/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cb = await svc.getChargeback(req.auth!.userId, id);
      return serialize(cb);
    } catch (e: any) {
      if (e.message === 'chargeback_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
