import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentRoutingRuleService } from '../../kopera/services/payment-routing-rule.js';

export async function registerPaymentRoutingRuleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentRoutingRuleService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    condition: z.string().min(1),
    targetGateway: z.string().min(1),
    priority: z.number().int().min(1),
    currency: z.string().min(1),
    minAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    maxAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (r: any) => ({
    ...r,
    minAmount: r.minAmount?.toString(),
    maxAmount: r.maxAmount?.toString(),
  });

  app.get('/api/payment-routing-rules/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRoutingAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-routing-rules/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getRules(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/payment-routing-rules/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createRule(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/payment-routing-rules/:id/match', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.recordMatch(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'routing_rule_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'rule_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-routing-rules/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const r = await svc.toggleRule(req.auth!.userId, id, active);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'routing_rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-routing-rules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteRule(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'routing_rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-routing-rules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getRule(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'routing_rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
