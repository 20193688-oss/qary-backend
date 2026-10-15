import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentReconciliationService } from '../../kopera/services/payment-reconciliation.js';

export async function registerPaymentReconciliationRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentReconciliationService(prisma);

  const createSchema = z.object({
    periodStart: z.string().min(1),
    periodEnd: z.string().min(1),
    currency: z.string().min(1),
    source: z.string().min(1),
  });

  const processSchema = z.object({
    matchedCount: z.number().int().min(0),
    unmatchedCount: z.number().int().min(0),
    totalExpected: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    totalActual: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (r: any) => ({
    ...r,
    totalExpected: r.totalExpected?.toString(),
    totalActual: r.totalActual?.toString(),
    discrepancy: r.discrepancy?.toString(),
  });

  app.get('/api/payment-reconciliations/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getReconciliationAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-reconciliations/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getReconciliations(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/payment-reconciliations/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createReconciliation(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/payment-reconciliations/:id/process', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = processSchema.parse(req.body);
    try {
      const r = await svc.processReconciliation(req.auth!.userId, id, data);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'reconciliation_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'reconciliation_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-reconciliations/:id/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.approveReconciliation(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'reconciliation_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'reconciliation_not_processed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-reconciliations/:id/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    try {
      const r = await svc.rejectReconciliation(req.auth!.userId, id, reason);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'reconciliation_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'reconciliation_not_processed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-reconciliations/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getReconciliation(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'reconciliation_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
