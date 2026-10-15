import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentCorridorService } from '../../kopera/services/payment-corridor.js';

export async function registerPaymentCorridorRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentCorridorService(prisma);

  const createSchema = z.object({
    sourceCurrency: z.string().length(3),
    targetCurrency: z.string().length(3),
    feePercentage: z.number().min(0),
    minAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    maxAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (c: any) => ({
    ...c,
    minAmount: c.minAmount?.toString(),
    maxAmount: c.maxAmount?.toString(),
    totalVolume: c.totalVolume?.toString(),
  });

  app.get('/api/payment-corridors/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCorridorAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-corridors/list', { preHandler: [app.requireAuth] }, async (req) => {
    const corridors = await svc.getCorridors(req.auth!.userId);
    return (corridors as any[]).map(serialize);
  });

  app.post('/api/payment-corridors/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const c = await svc.createCorridor(req.auth!.userId, data);
    reply.status(201);
    return serialize(c);
  });

  app.post('/api/payment-corridors/:id/record', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount } = z.object({ amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const c = await svc.recordTransaction(req.auth!.userId, id, amount);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'corridor_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'corridor_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-corridors/:id/fee', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { feePercentage } = z.object({ feePercentage: z.number().min(0) }).parse(req.body);
    try {
      const c = await svc.updateFee(req.auth!.userId, id, feePercentage);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'corridor_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-corridors/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const c = await svc.toggleCorridor(req.auth!.userId, id, active);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'corridor_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-corridors/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteCorridor(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'corridor_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-corridors/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.getCorridor(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'corridor_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
