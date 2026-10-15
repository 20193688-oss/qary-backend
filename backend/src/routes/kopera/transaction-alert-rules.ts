import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionAlertRuleService } from '../../kopera/services/transaction-alert-rule.js';

export async function registerTransactionAlertRuleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionAlertRuleService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    condition: z.string().min(1),
    threshold: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().min(1),
    channel: z.string().min(1),
  });

  const serialize = (r: any) => ({
    ...r,
    threshold: r.threshold?.toString(),
  });

  app.get('/api/transaction-alert-rules/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRuleAnalytics(req.auth!.userId);
  });

  app.get('/api/transaction-alert-rules/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getRules(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/transaction-alert-rules/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createRule(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/transaction-alert-rules/:id/trigger', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.triggerRule(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'rule_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-alert-rules/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const r = await svc.toggleRule(req.auth!.userId, id, active);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/transaction-alert-rules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteRule(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/transaction-alert-rules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getRule(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
