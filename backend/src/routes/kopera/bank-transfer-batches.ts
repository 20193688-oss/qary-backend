import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { BankTransferBatchService } from '../../kopera/services/bank-transfer-batch.js';

export async function registerBankTransferBatchRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new BankTransferBatchService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    currency: z.string().length(3),
    description: z.string().optional(),
  });

  const addItemSchema = z.object({
    recipientName: z.string().min(1),
    recipientAccount: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (b: any) => ({
    ...b,
    totalAmount: b.totalAmount?.toString(),
    amount: b.amount?.toString(),
  });

  app.get('/api/bank-transfer-batches/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getBatchAnalytics(req.auth!.userId);
  });

  app.get('/api/bank-transfer-batches/list', { preHandler: [app.requireAuth] }, async (req) => {
    const batches = await svc.getBatches(req.auth!.userId);
    return (batches as any[]).map(serialize);
  });

  app.post('/api/bank-transfer-batches/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const b = await svc.createBatch(req.auth!.userId, data);
    reply.status(201);
    return serialize(b);
  });

  app.post('/api/bank-transfer-batches/:id/add-item', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = addItemSchema.parse(req.body);
    try {
      const item = await svc.addItem(req.auth!.userId, id, data);
      reply.status(201);
      return serialize(item);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'batch_not_draft') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/bank-transfer-batches/:id/submit', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const b = await svc.submitBatch(req.auth!.userId, id);
      return serialize(b);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'batch_not_draft' || e.message === 'batch_empty') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/bank-transfer-batches/:id/process', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const b = await svc.processBatch(req.auth!.userId, id);
      return serialize(b);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'batch_not_submitted') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/bank-transfer-batches/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const b = await svc.cancelBatch(req.auth!.userId, id);
      return serialize(b);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'batch_already_completed' || e.message === 'batch_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/bank-transfer-batches/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const b = await svc.getBatch(req.auth!.userId, id);
      return serialize(b);
    } catch (e: any) {
      if (e.message === 'batch_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
