import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentMethodConfigService } from '../../kopera/services/payment-method-config.js';

export async function registerPaymentMethodConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentMethodConfigService(prisma);

  const createSchema = z.object({
    methodType: z.string().min(1),
    provider: z.string().min(1),
    currency: z.string().length(3),
    minAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    maxAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (c: any) => ({
    ...c,
    minAmount: c.minAmount?.toString(),
    maxAmount: c.maxAmount?.toString(),
  });

  app.get('/api/payment-method-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getConfigAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-method-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    const configs = await svc.getConfigs(req.auth!.userId);
    return (configs as any[]).map(serialize);
  });

  app.post('/api/payment-method-configs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const c = await svc.createConfig(req.auth!.userId, data);
    reply.status(201);
    return serialize(c);
  });

  app.post('/api/payment-method-configs/:id/limits', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { minAmount, maxAmount } = z.object({
      minAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
      maxAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    }).parse(req.body);
    try {
      const c = await svc.updateLimits(req.auth!.userId, id, minAmount, maxAmount);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-method-configs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
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

  app.delete('/api/payment-method-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteConfig(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-method-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
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
