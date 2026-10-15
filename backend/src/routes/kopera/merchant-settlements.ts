import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantSettlementService } from '../../kopera/services/merchant-settlement.js';

export async function registerMerchantSettlementRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantSettlementService(prisma);

  const createSchema = z.object({
    merchantName: z.string().min(1),
    merchantId: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    settlementPeriod: z.string().min(1),
  });

  const serialize = (s: any) => ({
    ...s,
    amount: s.amount?.toString(),
    fee: s.fee?.toString(),
    netAmount: s.netAmount?.toString(),
  });

  app.get('/api/merchant-settlements/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSettlementAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-settlements/list', { preHandler: [app.requireAuth] }, async (req) => {
    const settlements = await svc.getSettlements(req.auth!.userId);
    return (settlements as any[]).map(serialize);
  });

  app.post('/api/merchant-settlements/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const s = await svc.createSettlement(req.auth!.userId, data);
    reply.status(201);
    return serialize(s);
  });

  app.post('/api/merchant-settlements/:id/process', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.processSettlement(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'settlement_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'settlement_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-settlements/:id/complete', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.completeSettlement(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'settlement_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'settlement_not_processing') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-settlements/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.cancelSettlement(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'settlement_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'settlement_already_completed' || e.message === 'settlement_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-settlements/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.getSettlement(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'settlement_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
