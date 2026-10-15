import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantDiscountProgramService } from '../../kopera/services/merchant-discount-program.js';

export async function registerMerchantDiscountProgramRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantDiscountProgramService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    discountType: z.string().min(1),
    discountValue: z.number().min(0),
    merchantId: z.string().min(1),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    maxRedemptions: z.number().int().min(1),
  });

  const serialize = (p: any) => ({
    ...p,
    totalSavings: p.totalSavings?.toString(),
  });

  app.get('/api/merchant-discount-programs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getProgramAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-discount-programs/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getPrograms(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/merchant-discount-programs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const p = await svc.createProgram(req.auth!.userId, data);
    reply.status(201);
    return serialize(p);
  });

  app.post('/api/merchant-discount-programs/:id/redeem', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { savedAmount } = z.object({ savedAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const p = await svc.redeemDiscount(req.auth!.userId, id, savedAmount);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'program_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'program_not_active') { reply.status(400); return { error: e.message }; }
      if (e.message === 'max_redemptions_reached') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-discount-programs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const p = await svc.toggleProgram(req.auth!.userId, id, active);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'program_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/merchant-discount-programs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteProgram(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'program_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-discount-programs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const p = await svc.getProgram(req.auth!.userId, id);
      return serialize(p);
    } catch (e: any) {
      if (e.message === 'program_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
