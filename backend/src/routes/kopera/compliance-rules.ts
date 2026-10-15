import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ComplianceRuleService } from '../../kopera/services/compliance-rule.js';

export async function registerComplianceRuleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ComplianceRuleService(prisma);

  const createSchema = z.object({
    name: z.string().min(1).max(100),
    ruleType: z.string().min(1).max(50),
    condition: z.string().min(1).max(1000),
    action: z.string().min(1).max(500),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    description: z.string().max(500).optional(),
  });

  const updateSchema = z.object({
    condition: z.string().min(1).max(1000).optional(),
    action: z.string().min(1).max(500).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    description: z.string().max(500).optional(),
  });

  const toggleSchema = z.object({ active: z.boolean() });

  app.get('/api/compliance-rules/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRuleAnalytics(req.auth!.userId);
  });

  app.get('/api/compliance-rules/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRules(req.auth!.userId);
  });

  app.post('/api/compliance-rules/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const rule = await svc.createRule(req.auth!.userId, data);
      reply.status(201);
      return rule;
    } catch (e: any) {
      if (e.message === 'rule_name_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/compliance-rules/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      return await svc.updateRule(req.auth!.userId, id, data);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/compliance-rules/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = toggleSchema.parse(req.body);
    try {
      return await svc.toggleRule(req.auth!.userId, id, data.active);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/compliance-rules/:id/trigger', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.recordTrigger(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/compliance-rules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.deleteRule(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/compliance-rules/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getRule(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'rule_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
