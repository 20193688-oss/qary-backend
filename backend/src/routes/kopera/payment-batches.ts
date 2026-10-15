import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentBatchService } from '../../kopera/services/payment-batch.js';

export async function registerPaymentBatchRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentBatchService(prisma);

  const createSchema = z.object({
    batchName: z.string().min(1).max(200),
    currency: z.string().length(3),
    description: z.string().max(500).optional(),
    items: z.array(z.object({
      recipientName: z.string().min(1),
      recipientAccount: z.string().min(1),
      amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    })).min(1).max(500),
  });

  const serialize = (b: any) => ({ ...b, totalAmount: b.totalAmount?.toString() });

  app.get('/api/payment-batches/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getBatchAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-batches/list', { preHandler: [app.requireAuth] }, async (req) => {
    const batches = await svc.getBatches(req.auth!.userId);
    return (batches as any[]).map(serialize);
  });

  app.post('/api/payment-batches/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const batch = await svc.createBatch(req.auth!.userId, data);
    reply.status(201);
    return serialize(batch);
  });

  app.post('/api/payment-batches/:id/process', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const batch = await svc.processBatch(req.auth!.userId, id);
      return serialize(batch);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'batch_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-batches/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const batch = await svc.cancelBatch(req.auth!.userId, id);
      return serialize(batch);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'batch_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-batches/:id/items', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const items = await svc.getBatchItems(req.auth!.userId, id);
      return (items as any[]).map((i) => ({ ...i, amount: i.amount?.toString() }));
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-batches/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const batch = await svc.getBatch(req.auth!.userId, id);
      return serialize(batch);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
