import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TaxConfigService } from '../../kopera/services/tax-config.js';

export async function registerTaxConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TaxConfigService(prisma);

  const createSchema = z.object({
    taxType: z.string().min(1),
    jurisdiction: z.string().min(1),
    rate: z.number().min(0).max(1),
    currency: z.string().length(3),
    description: z.string().optional(),
    appliesTo: z.string().optional(),
  });

  const updateRateSchema = z.object({ rate: z.number().min(0).max(1) });
  const toggleSchema = z.object({ active: z.boolean() });
  const calculateSchema = z.object({
    taxType: z.string().min(1),
    jurisdiction: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (c: any) => ({ ...c });

  app.get('/api/tax-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTaxAnalytics(req.auth!.userId);
  });

  app.get('/api/tax-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    const configs = await svc.getConfigs(req.auth!.userId);
    return configs;
  });

  app.post('/api/tax-configs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const config = await svc.createConfig(req.auth!.userId, data);
      reply.status(201);
      return serialize(config);
    } catch (e: any) {
      if (e.message === 'tax_config_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/tax-configs/calculate', { preHandler: [app.requireAuth] }, async (req) => {
    const data = calculateSchema.parse(req.body);
    const result = await svc.calculateTax(req.auth!.userId, data.taxType, data.jurisdiction, data.amount);
    return { ...result, taxAmount: result.taxAmount.toString() };
  });

  app.post('/api/tax-configs/:id/rate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateRateSchema.parse(req.body);
    try {
      const config = await svc.updateRate(req.auth!.userId, id, data.rate);
      return serialize(config);
    } catch (e: any) {
      if (e.message === 'tax_config_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'invalid_tax_rate') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/tax-configs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = toggleSchema.parse(req.body);
    try {
      const config = await svc.toggleConfig(req.auth!.userId, id, data.active);
      return serialize(config);
    } catch (e: any) {
      if (e.message === 'tax_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/tax-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const config = await svc.deleteConfig(req.auth!.userId, id);
      return serialize(config);
    } catch (e: any) {
      if (e.message === 'tax_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/tax-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const config = await svc.getConfig(req.auth!.userId, id);
      return serialize(config);
    } catch (e: any) {
      if (e.message === 'tax_config_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
