import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { CrossBorderTransferService } from '../../kopera/services/cross-border-transfers.js';

export async function registerCrossBorderTransferRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new CrossBorderTransferService(prisma);

  const transferSchema = z.object({
    sourceCurrency: z.string().min(3).max(3),
    targetCurrency: z.string().min(3).max(3),
    amount: z.number().int().positive(),
    recipientName: z.string().min(1).max(200),
    recipientCountry: z.string().min(2).max(3),
    recipientBankCode: z.string().min(1).max(20),
    recipientAccountNumber: z.string().min(1).max(40),
    purpose: z.string().min(1).max(500),
  });

  const quoteSchema = z.object({
    sourceCurrency: z.string().min(3).max(3),
    targetCurrency: z.string().min(3).max(3),
    amount: z.string().or(z.number()),
  });

  app.get('/api/cross-border/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTransferAnalytics(req.auth!.userId);
  });

  app.post('/api/cross-border/quote', { preHandler: [app.requireAuth] }, async (req) => {
    const data = quoteSchema.parse(req.body);
    return svc.getQuote(data.sourceCurrency, data.targetCurrency, BigInt(Number(data.amount)));
  });

  app.get('/api/cross-border/transfers', { preHandler: [app.requireAuth] }, async (req) => {
    const transfers = await svc.getTransfers(req.auth!.userId);
    return transfers.map((t: any) => ({
      ...t,
      sourceAmount: t.sourceAmount.toString(),
      targetAmount: t.targetAmount.toString(),
      fee: t.fee.toString(),
    }));
  });

  app.post('/api/cross-border/transfer', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = transferSchema.parse(req.body);
    try {
      const transfer = await svc.initiateTransfer(req.auth!.userId, {
        ...data,
        amount: BigInt(data.amount),
      });
      reply.status(201);
      return {
        ...(transfer as any),
        sourceAmount: (transfer as any).sourceAmount.toString(),
        targetAmount: (transfer as any).targetAmount.toString(),
        fee: (transfer as any).fee.toString(),
      };
    } catch (e: any) {
      throw e;
    }
  });

  app.get('/api/cross-border/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const transfer = await svc.getTransfer(req.auth!.userId, id);
      return {
        ...(transfer as any),
        sourceAmount: (transfer as any).sourceAmount.toString(),
        targetAmount: (transfer as any).targetAmount.toString(),
        fee: (transfer as any).fee.toString(),
      };
    } catch (e: any) {
      if (e.message === 'transfer_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/cross-border/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transfer = await svc.cancelTransfer(req.auth!.userId, id);
      return {
        ...(transfer as any),
        sourceAmount: (transfer as any).sourceAmount.toString(),
        targetAmount: (transfer as any).targetAmount.toString(),
        fee: (transfer as any).fee.toString(),
      };
    } catch (e: any) {
      if (e.message === 'transfer_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'transfer_not_cancellable') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });
}
