import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { FeeScheduleService } from '../../kopera/services/fee-schedule.js';

export async function registerFeeScheduleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new FeeScheduleService(prisma);

  const createSchema = z.object({
    transactionType: z.string().min(1).max(100),
    feeType: z.enum(['FIXED', 'PERCENTAGE', 'COMBINED']),
    fixedAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
    percentageRate: z.number().min(0).max(1).optional(),
    currency: z.string().length(3),
    minAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
    maxAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
  });

  const updateSchema = z.object({
    fixedAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
    percentageRate: z.number().min(0).max(1).optional(),
    minAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
    maxAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
  });

  const calculateSchema = z.object({
    transactionType: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
  });

  app.get('/api/fee-schedules/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getFeeAnalytics(req.auth!.userId);
  });

  app.get('/api/fee-schedules/list', { preHandler: [app.requireAuth] }, async (req) => {
    const fees = await svc.getFees(req.auth!.userId);
    return (fees as any[]).map((f) => ({
      ...f,
      fixedAmount: f.fixedAmount?.toString(),
      minAmount: f.minAmount?.toString(),
      maxAmount: f.maxAmount?.toString(),
    }));
  });

  app.post('/api/fee-schedules/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const fee = await svc.createFee(req.auth!.userId, data);
      reply.status(201);
      return {
        ...fee,
        fixedAmount: (fee as any).fixedAmount?.toString(),
        minAmount: (fee as any).minAmount?.toString(),
        maxAmount: (fee as any).maxAmount?.toString(),
      };
    } catch (e: any) {
      if (e.message === 'fee_already_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/fee-schedules/calculate', { preHandler: [app.requireAuth] }, async (req) => {
    const data = calculateSchema.parse(req.body);
    const result = await svc.calculateFee(req.auth!.userId, data.transactionType, data.amount, data.currency);
    return { ...result, feeAmount: result.feeAmount.toString() };
  });

  app.post('/api/fee-schedules/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      const fee = await svc.updateFee(req.auth!.userId, id, data);
      return {
        ...fee,
        fixedAmount: (fee as any).fixedAmount?.toString(),
        minAmount: (fee as any).minAmount?.toString(),
        maxAmount: (fee as any).maxAmount?.toString(),
      };
    } catch (e: any) {
      if (e.message === 'fee_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/fee-schedules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const fee = await svc.removeFee(req.auth!.userId, id);
      return {
        ...fee,
        fixedAmount: (fee as any).fixedAmount?.toString(),
        minAmount: (fee as any).minAmount?.toString(),
        maxAmount: (fee as any).maxAmount?.toString(),
      };
    } catch (e: any) {
      if (e.message === 'fee_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/fee-schedules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const fee = await svc.getFee(req.auth!.userId, id);
      return {
        ...fee,
        fixedAmount: (fee as any).fixedAmount?.toString(),
        minAmount: (fee as any).minAmount?.toString(),
        maxAmount: (fee as any).maxAmount?.toString(),
      };
    } catch (e: any) {
      if (e.message === 'fee_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
