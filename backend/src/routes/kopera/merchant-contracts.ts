import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantContractService } from '../../kopera/services/merchant-contract.js';

export async function registerMerchantContractRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantContractService(prisma);

  const createSchema = z.object({
    merchantId: z.string().min(1),
    contractType: z.string().min(1),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    terms: z.string().min(1),
    monthlyFee: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (c: any) => ({
    ...c,
    monthlyFee: c.monthlyFee?.toString(),
    totalBilled: c.totalBilled?.toString(),
  });

  app.get('/api/merchant-contracts/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getContractAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-contracts/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getContracts(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/merchant-contracts/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const c = await svc.createContract(req.auth!.userId, data);
    reply.status(201);
    return serialize(c);
  });

  app.post('/api/merchant-contracts/:id/activate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.activateContract(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'contract_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'contract_not_draft') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-contracts/:id/bill', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.billCycle(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'contract_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'contract_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-contracts/:id/terminate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    try {
      const c = await svc.terminateContract(req.auth!.userId, id, reason);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'contract_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'contract_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-contracts/:id/renew', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { newEndDate } = z.object({ newEndDate: z.string().min(1) }).parse(req.body);
    try {
      const c = await svc.renewContract(req.auth!.userId, id, newEndDate);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'contract_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'contract_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-contracts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.getContract(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'contract_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
