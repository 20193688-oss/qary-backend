import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AccountTierService } from '../../kopera/services/account-tier.js';

export async function registerAccountTierRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new AccountTierService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    level: z.number().int().positive(),
    monthlyFee: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    transactionLimit: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    description: z.string().optional(),
  });

  const serialize = (t: any) => ({
    ...t,
    monthlyFee: t.monthlyFee?.toString(),
    transactionLimit: t.transactionLimit?.toString(),
  });

  app.get('/api/account-tiers/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTierAnalytics(req.auth!.userId);
  });

  app.get('/api/account-tiers/list', { preHandler: [app.requireAuth] }, async (req) => {
    const tiers = await svc.getTiers(req.auth!.userId);
    return (tiers as any[]).map(serialize);
  });

  app.post('/api/account-tiers/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const t = await svc.createTier(req.auth!.userId, data);
      reply.status(201);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tier_exists') { reply.status(409); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-tiers/:id/fee', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { monthlyFee } = z.object({ monthlyFee: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const t = await svc.updateFee(req.auth!.userId, id, monthlyFee);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tier_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-tiers/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const t = await svc.toggleTier(req.auth!.userId, id, active);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tier_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/account-tiers/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = await svc.deleteTier(req.auth!.userId, id);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tier_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/account-tiers/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = await svc.getTier(req.auth!.userId, id);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tier_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
