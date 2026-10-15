import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantFeeOverrideService } from '../../kopera/services/merchant-fee-override.js';

export async function registerMerchantFeeOverrideRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantFeeOverrideService(prisma);

  const createSchema = z.object({
    merchantId: z.string().min(1),
    feeType: z.string().min(1),
    feePercent: z.number().min(0),
    flatFee: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().min(1),
    effectiveFrom: z.string().min(1),
  });

  const serialize = (o: any) => ({
    ...o,
    flatFee: o.flatFee?.toString(),
    totalFeeCollected: o.totalFeeCollected?.toString(),
  });

  app.get('/api/merchant-fee-overrides/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getOverrideAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-fee-overrides/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getOverrides(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/merchant-fee-overrides/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const o = await svc.createOverride(req.auth!.userId, data);
    reply.status(201);
    return serialize(o);
  });

  app.post('/api/merchant-fee-overrides/:id/apply', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount } = z.object({ amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const o = await svc.applyFee(req.auth!.userId, id, amount);
      return serialize(o);
    } catch (e: any) {
      if (e.message === 'override_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'override_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-fee-overrides/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const o = await svc.toggleOverride(req.auth!.userId, id, active);
      return serialize(o);
    } catch (e: any) {
      if (e.message === 'override_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/merchant-fee-overrides/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteOverride(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'override_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-fee-overrides/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const o = await svc.getOverride(req.auth!.userId, id);
      return serialize(o);
    } catch (e: any) {
      if (e.message === 'override_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
