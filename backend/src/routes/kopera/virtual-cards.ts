import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { VirtualCardService } from '../../kopera/services/virtual-card.js';

export async function registerVirtualCardRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new VirtualCardService(prisma);

  const issueSchema = z.object({
    cardName: z.string().min(1),
    currency: z.string().length(3),
    spendingLimit: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    expiresAt: z.string().transform((v) => new Date(v)),
    category: z.string().optional(),
  });

  const spendSchema = z.object({
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (c: any) => ({
    ...c,
    spendingLimit: c.spendingLimit?.toString(),
    currentSpend: c.currentSpend?.toString(),
  });

  app.get('/api/virtual-cards/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCardAnalytics(req.auth!.userId);
  });

  app.get('/api/virtual-cards/list', { preHandler: [app.requireAuth] }, async (req) => {
    const cards = await svc.getCards(req.auth!.userId);
    return (cards as any[]).map(serialize);
  });

  app.post('/api/virtual-cards/issue', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = issueSchema.parse(req.body);
    const card = await svc.issueCard(req.auth!.userId, data);
    reply.status(201);
    return serialize(card);
  });

  app.post('/api/virtual-cards/:id/spend', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = spendSchema.parse(req.body);
    try {
      const card = await svc.recordSpend(req.auth!.userId, id, data.amount);
      return serialize(card);
    } catch (e: any) {
      if (e.message === 'card_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'card_not_active') { reply.status(400); return { error: e.message }; }
      if (e.message === 'spending_limit_exceeded') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/virtual-cards/:id/freeze', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const card = await svc.freezeCard(req.auth!.userId, id);
      return serialize(card);
    } catch (e: any) {
      if (e.message === 'card_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'card_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/virtual-cards/:id/unfreeze', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const card = await svc.unfreezeCard(req.auth!.userId, id);
      return serialize(card);
    } catch (e: any) {
      if (e.message === 'card_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'card_not_frozen') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/virtual-cards/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const card = await svc.cancelCard(req.auth!.userId, id);
      return serialize(card);
    } catch (e: any) {
      if (e.message === 'card_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'card_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/virtual-cards/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const card = await svc.getCard(req.auth!.userId, id);
      return serialize(card);
    } catch (e: any) {
      if (e.message === 'card_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
