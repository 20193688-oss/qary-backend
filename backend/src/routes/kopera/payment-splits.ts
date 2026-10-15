import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentSplitService } from '../../kopera/services/payment-split.js';

export async function registerPaymentSplitRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentSplitService(prisma);

  const createSchema = z.object({
    description: z.string().min(1),
    totalAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    recipients: z.array(z.object({
      name: z.string().min(1),
      accountId: z.string().min(1),
      share: z.number().min(0).max(1),
    })).min(2),
  });

  const serialize = (s: any) => ({
    ...s,
    totalAmount: s.totalAmount?.toString(),
  });

  const serializeRecipient = (r: any) => ({
    ...r,
    amount: r.amount?.toString(),
  });

  app.get('/api/payment-splits/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSplitAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-splits/list', { preHandler: [app.requireAuth] }, async (req) => {
    const splits = await svc.getSplits(req.auth!.userId);
    return (splits as any[]).map(serialize);
  });

  app.post('/api/payment-splits/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const split = await svc.createSplit(req.auth!.userId, data);
      reply.status(201);
      return serialize(split);
    } catch (e: any) {
      if (e.message === 'shares_must_equal_one') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-splits/:id/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const split = await svc.executeSplit(req.auth!.userId, id);
      return serialize(split);
    } catch (e: any) {
      if (e.message === 'split_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'split_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-splits/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const split = await svc.cancelSplit(req.auth!.userId, id);
      return serialize(split);
    } catch (e: any) {
      if (e.message === 'split_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'split_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-splits/:id/recipients', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const recipients = await svc.getSplitRecipients(req.auth!.userId, id);
      return (recipients as any[]).map(serializeRecipient);
    } catch (e: any) {
      if (e.message === 'split_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-splits/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const split = await svc.getSplit(req.auth!.userId, id);
      return serialize(split);
    } catch (e: any) {
      if (e.message === 'split_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
