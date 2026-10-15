import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { CreditExpressService } from '../../kopera/services/credit-express.js';

export async function registerCreditExpressRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new CreditExpressService(prisma);

  const applySchema = z.object({
    currency: z.string().min(3).max(3),
    requestedAmount: z.number().int().positive(),
    termMonths: z.number().int().min(1).max(60),
    purpose: z.string().min(1).max(500),
  });

  const disburseSchema = z.object({
    amount: z.number().int().positive(),
    targetCurrency: z.string().min(3).max(3).optional(),
  });

  const repaySchema = z.object({
    amount: z.number().int().positive(),
  });

  app.get('/api/credit-express/summary', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCreditSummary(req.auth!.userId);
  });

  app.get('/api/credit-express/lines', { preHandler: [app.requireAuth] }, async (req) => {
    const lines = await svc.getCreditLines(req.auth!.userId);
    return lines.map((l: any) => ({
      ...l,
      creditLimit: l.creditLimit.toString(),
      availableCredit: l.availableCredit.toString(),
      usedCredit: l.usedCredit.toString(),
    }));
  });

  app.post('/api/credit-express/apply', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = applySchema.parse(req.body);
    try {
      const line = await svc.applyForCredit(req.auth!.userId, {
        ...data,
        requestedAmount: BigInt(data.requestedAmount),
      });
      reply.status(201);
      return {
        ...(line as any),
        creditLimit: (line as any).creditLimit.toString(),
        availableCredit: (line as any).availableCredit.toString(),
        usedCredit: (line as any).usedCredit.toString(),
      };
    } catch (e: any) {
      if (e.message === 'active_credit_line_exists') {
        reply.status(409);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.get('/api/credit-express/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const line = await svc.getCreditLine(req.auth!.userId, id);
      return {
        ...(line as any),
        creditLimit: (line as any).creditLimit.toString(),
        availableCredit: (line as any).availableCredit.toString(),
        usedCredit: (line as any).usedCredit.toString(),
      };
    } catch (e: any) {
      if (e.message === 'credit_line_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/credit-express/:id/disburse', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = disburseSchema.parse(req.body);
    try {
      const disbursement = await svc.disburse(
        req.auth!.userId, id, BigInt(data.amount), data.targetCurrency,
      );
      reply.status(201);
      return {
        ...(disbursement as any),
        amount: (disbursement as any).amount.toString(),
      };
    } catch (e: any) {
      if (e.message === 'credit_line_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'credit_line_not_active' || e.message === 'insufficient_credit') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/credit-express/:id/repay', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = repaySchema.parse(req.body);
    try {
      const repayment = await svc.repay(req.auth!.userId, id, BigInt(data.amount));
      reply.status(201);
      return {
        ...(repayment as any),
        amount: (repayment as any).amount.toString(),
      };
    } catch (e: any) {
      if (e.message === 'credit_line_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'repayment_exceeds_balance') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });
}
