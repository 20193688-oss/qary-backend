import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { WireTransferService } from '../../kopera/services/wire-transfer.js';

export async function registerWireTransferRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new WireTransferService(prisma);

  const initiateSchema = z.object({
    recipientName: z.string().min(1),
    recipientBank: z.string().min(1),
    recipientAccount: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    swiftCode: z.string().optional(),
    memo: z.string().optional(),
  });

  const serialize = (t: any) => ({
    ...t,
    amount: t.amount?.toString(),
    fee: t.fee?.toString(),
  });

  app.get('/api/wire-transfers/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTransferAnalytics(req.auth!.userId);
  });

  app.get('/api/wire-transfers/list', { preHandler: [app.requireAuth] }, async (req) => {
    const transfers = await svc.getTransfers(req.auth!.userId);
    return (transfers as any[]).map(serialize);
  });

  app.post('/api/wire-transfers/initiate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = initiateSchema.parse(req.body);
    const transfer = await svc.initiateTransfer(req.auth!.userId, data);
    reply.status(201);
    return serialize(transfer);
  });

  app.post('/api/wire-transfers/:id/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transfer = await svc.approveTransfer(req.auth!.userId, id);
      return serialize(transfer);
    } catch (e: any) {
      if (e.message === 'wire_transfer_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'wire_not_initiated') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/wire-transfers/:id/complete', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transfer = await svc.completeTransfer(req.auth!.userId, id);
      return serialize(transfer);
    } catch (e: any) {
      if (e.message === 'wire_transfer_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'wire_not_approved') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/wire-transfers/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transfer = await svc.cancelTransfer(req.auth!.userId, id);
      return serialize(transfer);
    } catch (e: any) {
      if (e.message === 'wire_transfer_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'wire_already_completed') { reply.status(400); return { error: e.message }; }
      if (e.message === 'wire_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/wire-transfers/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const transfer = await svc.getTransfer(req.auth!.userId, id);
      return serialize(transfer);
    } catch (e: any) {
      if (e.message === 'wire_transfer_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
