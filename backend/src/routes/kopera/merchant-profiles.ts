import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantProfileService } from '../../kopera/services/merchant-profile.js';

export async function registerMerchantProfileRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantProfileService(prisma);

  const createSchema = z.object({
    merchantName: z.string().min(1).max(200),
    merchantCode: z.string().min(1).max(50),
    category: z.string().min(1).max(100),
    country: z.string().length(2),
    currency: z.string().length(3),
    contactEmail: z.string().email().optional(),
    website: z.string().url().optional(),
  });

  const updateSchema = z.object({
    merchantName: z.string().min(1).max(200).optional(),
    category: z.string().min(1).max(100).optional(),
    contactEmail: z.string().email().optional(),
    website: z.string().url().optional(),
  });

  const txSchema = z.object({
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (p: any) => ({
    ...p,
    totalVolume: p.totalVolume?.toString(),
  });

  app.get('/api/merchant-profiles/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getMerchantAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-profiles/list', { preHandler: [app.requireAuth] }, async (req) => {
    const profiles = await svc.getProfiles(req.auth!.userId);
    return (profiles as any[]).map(serialize);
  });

  app.post('/api/merchant-profiles/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const profile = await svc.createProfile(req.auth!.userId, data);
      reply.status(201);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'merchant_code_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-profiles/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      const profile = await svc.updateProfile(req.auth!.userId, id, data);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'merchant_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-profiles/:id/suspend', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const profile = await svc.suspendProfile(req.auth!.userId, id);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'merchant_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'merchant_already_suspended') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-profiles/:id/activate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const profile = await svc.activateProfile(req.auth!.userId, id);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'merchant_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'merchant_already_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-profiles/:id/record-transaction', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = txSchema.parse(req.body);
    try {
      const profile = await svc.recordTransaction(req.auth!.userId, id, data.amount);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'merchant_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-profiles/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const profile = await svc.getProfile(req.auth!.userId, id);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'merchant_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
