import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { CurrencyExchangeRateService } from '../../kopera/services/currency-exchange-rate.js';

export async function registerCurrencyExchangeRateRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new CurrencyExchangeRateService(prisma);

  const createSchema = z.object({
    baseCurrency: z.string().min(1),
    targetCurrency: z.string().min(1),
    rate: z.number().positive(),
    marginPercent: z.number().min(0),
    source: z.string().min(1),
  });

  const updateSchema = z.object({
    rate: z.number().positive(),
    marginPercent: z.number().min(0),
  });

  const serialize = (r: any) => ({
    ...r,
    totalVolumeConverted: r.totalVolumeConverted?.toString(),
  });

  app.get('/api/currency-exchange-rates/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRateAnalytics(req.auth!.userId);
  });

  app.get('/api/currency-exchange-rates/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getRates(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/currency-exchange-rates/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createRate(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/currency-exchange-rates/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      const r = await svc.updateRate(req.auth!.userId, id, data);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'rate_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/currency-exchange-rates/:id/record', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { volume } = z.object({ volume: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const r = await svc.recordUsage(req.auth!.userId, id, volume);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'rate_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'rate_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/currency-exchange-rates/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const r = await svc.toggleRate(req.auth!.userId, id, active);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'rate_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/currency-exchange-rates/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteRate(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'rate_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/currency-exchange-rates/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getRate(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'rate_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
