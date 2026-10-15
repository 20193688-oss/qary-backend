import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionCategoryService } from '../../kopera/services/transaction-category.js';

export async function registerTransactionCategoryRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionCategoryService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    icon: z.string().min(1),
    color: z.string().min(1),
    description: z.string().optional(),
  });

  const serialize = (c: any) => ({
    ...c,
    totalAmount: c.totalAmount?.toString(),
  });

  app.get('/api/transaction-categories/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCategoryAnalytics(req.auth!.userId);
  });

  app.get('/api/transaction-categories/list', { preHandler: [app.requireAuth] }, async (req) => {
    const cats = await svc.getCategories(req.auth!.userId);
    return (cats as any[]).map(serialize);
  });

  app.post('/api/transaction-categories/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const c = await svc.createCategory(req.auth!.userId, data);
      reply.status(201);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'category_exists') { reply.status(409); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-categories/:id/categorize', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount } = z.object({ amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)) }).parse(req.body);
    try {
      const c = await svc.categorizeTransaction(req.auth!.userId, id, amount);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'category_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'category_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-categories/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const c = await svc.toggleCategory(req.auth!.userId, id, active);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/transaction-categories/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteCategory(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/transaction-categories/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.getCategory(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
