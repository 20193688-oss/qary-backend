import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentGatewayConfigService } from '../../kopera/services/payment-gateway-config.js';

export async function registerPaymentGatewayConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentGatewayConfigService(prisma);

  const createSchema = z.object({
    gatewayName: z.string().min(1),
    environment: z.string().min(1),
    supportedCurrencies: z.string().min(1),
    merchantId: z.string().min(1),
  });

  const serialize = (c: any) => ({
    ...c,
    totalVolume: c.totalVolume?.toString(),
  });

  app.get('/api/payment-gateway-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getGatewayAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-gateway-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    const configs = await svc.getConfigs(req.auth!.userId);
    return (configs as any[]).map(serialize);
  });

  app.post('/api/payment-gateway-configs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const c = await svc.createConfig(req.auth!.userId, data);
    reply.status(201);
    return serialize(c);
  });

  app.post('/api/payment-gateway-configs/:id/record', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount } = z.object({ amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const c = await svc.recordTransaction(req.auth!.userId, id, amount);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'gateway_config_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'gateway_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-gateway-configs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const c = await svc.toggleConfig(req.auth!.userId, id, active);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'gateway_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-gateway-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteConfig(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'gateway_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-gateway-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.getConfig(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'gateway_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
