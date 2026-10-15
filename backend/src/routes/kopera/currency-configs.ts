import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { CurrencyConfigService } from '../../kopera/services/currency-config.js';

export async function registerCurrencyConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new CurrencyConfigService(prisma);

  const setSchema = z.object({
    currency: z.string().min(3).max(3),
    displayDecimals: z.number().int().min(0).max(8).optional(),
    roundingMode: z.enum(['half_up', 'half_down', 'ceil', 'floor', 'truncate']).optional(),
    isDefault: z.boolean().optional(),
  });

  app.get('/api/currency-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCurrencyAnalytics(req.auth!.userId);
  });

  app.get('/api/currency-configs/default', { preHandler: [app.requireAuth] }, async (req) => {
    const config = await svc.getDefaultCurrency(req.auth!.userId);
    return config || { default: null };
  });

  app.get('/api/currency-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getConfigs(req.auth!.userId);
  });

  app.post('/api/currency-configs/set', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = setSchema.parse(req.body);
    const config = await svc.setConfig(req.auth!.userId, data);
    reply.status(201);
    return config;
  });

  app.delete('/api/currency-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.removeConfig(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'currency_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/currency-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getConfig(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'currency_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
