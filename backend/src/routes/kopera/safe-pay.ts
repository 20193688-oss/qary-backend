import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { SafePayService } from '../../kopera/services/safe-pay.js';

export async function registerSafePayRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new SafePayService(prisma);

  const createSchema = z.object({
    transactionId: z.string().optional(),
    amount: z.number().int().positive(),
    currency: z.string().min(3).max(3),
    merchantName: z.string().min(1).max(200),
    merchantId: z.string().optional(),
    channel: z.string().min(1).max(50),
  });

  const confirmSchema = z.object({
    confirmationCode: z.string().length(6),
    secretKey: z.string().optional(),
  });

  app.get('/api/safe-pay/metrics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getConfirmationMetrics(req.auth!.userId);
  });

  app.get('/api/safe-pay/pending', { preHandler: [app.requireAuth] }, async (req) => {
    const pending = await svc.getPendingConfirmations(req.auth!.userId);
    return pending.map((c: any) => ({
      ...c,
      amount: c.amount.toString(),
    }));
  });

  app.get('/api/safe-pay/confirmations', { preHandler: [app.requireAuth] }, async (req) => {
    const confirmations = await svc.getConfirmations(req.auth!.userId);
    return confirmations.map((c: any) => ({
      ...c,
      amount: c.amount.toString(),
    }));
  });

  app.post('/api/safe-pay/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const confirmation = await svc.createConfirmation(req.auth!.userId, {
      ...data,
      amount: BigInt(data.amount),
    });
    reply.status(201);
    return {
      ...(confirmation as any),
      amount: (confirmation as any).amount.toString(),
    };
  });

  app.post('/api/safe-pay/:id/confirm', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = confirmSchema.parse(req.body);
    try {
      const result = await svc.confirmPayment(req.auth!.userId, id, data);
      return {
        ...(result as any),
        amount: (result as any).amount.toString(),
      };
    } catch (e: any) {
      if (e.message === 'confirmation_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (['confirmation_already_resolved', 'confirmation_expired', 'invalid_confirmation_code', 'confirmation_blocked', 'invalid_secret_key'].includes(e.message)) {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/safe-pay/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await svc.cancelConfirmation(req.auth!.userId, id);
      return {
        ...(result as any),
        amount: (result as any).amount.toString(),
      };
    } catch (e: any) {
      if (e.message === 'confirmation_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'confirmation_already_resolved') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });
}
