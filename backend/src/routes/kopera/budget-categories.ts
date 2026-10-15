import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { BudgetCategoryService } from '../../kopera/services/budget-category.js';

export async function registerBudgetCategoryRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new BudgetCategoryService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    budgetLimit: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    period: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    description: z.string().optional(),
  });

  const spendSchema = z.object({
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const limitSchema = z.object({
    budgetLimit: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (c: any) => ({
    ...c,
    budgetLimit: c.budgetLimit?.toString(),
    currentSpend: c.currentSpend?.toString(),
  });

  app.get('/api/budget-categories/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getBudgetAnalytics(req.auth!.userId);
  });

  app.get('/api/budget-categories/list', { preHandler: [app.requireAuth] }, async (req) => {
    const cats = await svc.getCategories(req.auth!.userId);
    return (cats as any[]).map(serialize);
  });

  app.post('/api/budget-categories/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const cat = await svc.createCategory(req.auth!.userId, data);
      reply.status(201);
      return serialize(cat);
    } catch (e: any) {
      if (e.message === 'budget_category_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/budget-categories/:id/spend', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = spendSchema.parse(req.body);
    try {
      const cat = await svc.recordSpend(req.auth!.userId, id, data.amount);
      return serialize(cat);
    } catch (e: any) {
      if (e.message === 'budget_category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/budget-categories/:id/reset', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cat = await svc.resetSpend(req.auth!.userId, id);
      return serialize(cat);
    } catch (e: any) {
      if (e.message === 'budget_category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/budget-categories/:id/limit', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = limitSchema.parse(req.body);
    try {
      const cat = await svc.updateLimit(req.auth!.userId, id, data.budgetLimit);
      return serialize(cat);
    } catch (e: any) {
      if (e.message === 'budget_category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/budget-categories/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cat = await svc.deleteCategory(req.auth!.userId, id);
      return serialize(cat);
    } catch (e: any) {
      if (e.message === 'budget_category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/budget-categories/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const cat = await svc.getCategory(req.auth!.userId, id);
      return serialize(cat);
    } catch (e: any) {
      if (e.message === 'budget_category_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
