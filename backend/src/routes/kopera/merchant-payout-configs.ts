import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantPayoutConfigService } from '../../kopera/services/merchant-payout-config.js';

export async function registerMerchantPayoutConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantPayoutConfigService(prisma);

  const createSchema = z.object({
    merchantId: z.string().min(1),
    frequency: z.string().min(1),
    minimumPayout: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().min(1),
    bankAccountId: z.string().min(1),
  });

  const serialize = (c: any) => ({
    ...c,
    minimumPayout: c.minimumPayout?.toString(),
    totalPaidOut: c.totalPaidOut?.toString(),
  });

  app.get('/api/merchant-payout-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getConfigAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-payout-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getConfigs(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/merchant-payout-configs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const c = await svc.createConfig(req.auth!.userId, data);
    reply.status(201);
    return serialize(c);
  });

  app.post('/api/merchant-payout-configs/:id/record', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount } = z.object({ amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const c = await svc.recordPayout(req.auth!.userId, id, amount);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'config_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'config_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-payout-configs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const c = await svc.toggleConfig(req.auth!.userId, id, active);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/merchant-payout-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteConfig(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-payout-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.getConfig(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
