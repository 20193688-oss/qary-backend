import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ComplianceCheckService } from '../../kopera/services/compliance-check.js';

export async function registerComplianceCheckRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ComplianceCheckService(prisma);

  const createSchema = z.object({
    checkType: z.string().min(1),
    entityId: z.string().min(1),
    entityType: z.string().min(1),
  });

  const serialize = (c: any) => ({ ...c });

  app.get('/api/compliance-checks/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCheckAnalytics(req.auth!.userId);
  });

  app.get('/api/compliance-checks/list', { preHandler: [app.requireAuth] }, async (req) => {
    const checks = await svc.getChecks(req.auth!.userId);
    return (checks as any[]).map(serialize);
  });

  app.post('/api/compliance-checks/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const c = await svc.createCheck(req.auth!.userId, data);
    reply.status(201);
    return serialize(c);
  });

  app.post('/api/compliance-checks/:id/complete', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { riskLevel, findings } = z.object({ riskLevel: z.string().min(1), findings: z.string().optional() }).parse(req.body);
    try {
      const c = await svc.completeCheck(req.auth!.userId, id, riskLevel, findings);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'check_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'check_not_in_progress') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/compliance-checks/:id/flag', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    try {
      const c = await svc.flagCheck(req.auth!.userId, id, reason);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'check_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'check_not_completed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/compliance-checks/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await svc.getCheck(req.auth!.userId, id);
      return serialize(c);
    } catch (e: any) {
      if (e.message === 'check_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
