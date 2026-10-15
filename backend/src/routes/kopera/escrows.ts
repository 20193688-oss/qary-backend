import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { EscrowService } from '../../kopera/services/escrow.js';

export async function registerEscrowRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new EscrowService(prisma);

  const createSchema = z.object({
    counterpartyName: z.string().min(1),
    counterpartyEmail: z.string().email(),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    description: z.string().min(1),
    expiresAt: z.string().transform((v) => new Date(v)).optional(),
  });

  const disputeSchema = z.object({ reason: z.string().min(1) });

  const serialize = (e: any) => ({ ...e, amount: e.amount?.toString() });

  app.get('/api/escrows/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getEscrowAnalytics(req.auth!.userId);
  });

  app.get('/api/escrows/list', { preHandler: [app.requireAuth] }, async (req) => {
    const escrows = await svc.getEscrows(req.auth!.userId);
    return (escrows as any[]).map(serialize);
  });

  app.post('/api/escrows/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const escrow = await svc.createEscrow(req.auth!.userId, data);
    reply.status(201);
    return serialize(escrow);
  });

  app.post('/api/escrows/:id/release', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const escrow = await svc.releaseEscrow(req.auth!.userId, id);
      return serialize(escrow);
    } catch (e: any) {
      if (e.message === 'escrow_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'escrow_not_funded') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/escrows/:id/dispute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = disputeSchema.parse(req.body);
    try {
      const escrow = await svc.disputeEscrow(req.auth!.userId, id, data.reason);
      return serialize(escrow);
    } catch (e: any) {
      if (e.message === 'escrow_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'escrow_not_funded') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/escrows/:id/refund', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const escrow = await svc.refundEscrow(req.auth!.userId, id);
      return serialize(escrow);
    } catch (e: any) {
      if (e.message === 'escrow_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'escrow_cannot_refund') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/escrows/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const escrow = await svc.getEscrow(req.auth!.userId, id);
      return serialize(escrow);
    } catch (e: any) {
      if (e.message === 'escrow_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
