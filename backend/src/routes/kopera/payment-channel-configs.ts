import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentChannelConfigService } from '../../kopera/services/payment-channel-config.js';

export async function registerPaymentChannelConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentChannelConfigService(prisma);

  const createSchema = z.object({
    channelName: z.string().min(1),
    channelType: z.string().min(1),
    supportedMethods: z.string().min(1),
    currency: z.string().min(1),
    feePercent: z.number().min(0),
  });

  const serialize = (c: any) => ({
    ...c,
    totalVolume: c.totalVolume?.toString(),
  });

  app.get('/api/payment-channel-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getChannelAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-channel-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getConfigs(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/payment-channel-configs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const c = await svc.createConfig(req.auth!.userId, data);
    reply.status(201);
    return serialize(c);
  });

  app.post('/api/payment-channel-configs/:id/record', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount } = z.object({ amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const c = await svc.recordTransaction(req.auth!.userId, id, amount);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'channel_config_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'channel_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-channel-configs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const c = await svc.toggleConfig(req.auth!.userId, id, active);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'channel_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-channel-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteConfig(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'channel_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-channel-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.getConfig(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'channel_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
