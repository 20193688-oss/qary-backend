import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionTagService } from '../../kopera/services/transaction-tag.js';

export async function registerTransactionTagRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionTagService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    color: z.string().min(1),
    description: z.string().optional(),
  });

  const serialize = (t: any) => ({ ...t });

  app.get('/api/transaction-tags/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTagAnalytics(req.auth!.userId);
  });

  app.get('/api/transaction-tags/list', { preHandler: [app.requireAuth] }, async (req) => {
    const tags = await svc.getTags(req.auth!.userId);
    return (tags as any[]).map(serialize);
  });

  app.post('/api/transaction-tags/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const t = await svc.createTag(req.auth!.userId, data);
      reply.status(201);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tag_exists') { reply.status(409); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-tags/:id/apply', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = await svc.applyTag(req.auth!.userId, id);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tag_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'tag_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-tags/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const t = await svc.toggleTag(req.auth!.userId, id, active);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tag_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/transaction-tags/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteTag(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'tag_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/transaction-tags/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = await svc.getTag(req.auth!.userId, id);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'tag_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
