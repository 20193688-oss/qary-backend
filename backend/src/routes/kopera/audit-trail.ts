import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AuditTrailService } from '../../kopera/services/audit-trail.js';

export async function registerAuditTrailRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new AuditTrailService(prisma);

  const logSchema = z.object({
    action: z.string().min(1).max(100),
    resourceType: z.string().min(1).max(100),
    resourceId: z.string().min(1).max(200),
    details: z.string().max(2000).optional(),
    ipAddress: z.string().max(45).optional(),
    userAgent: z.string().max(500).optional(),
  });

  app.get('/api/audit-trail/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getAuditAnalytics(req.auth!.userId);
  });

  app.get('/api/audit-trail/entries', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getEntries(req.auth!.userId);
  });

  app.post('/api/audit-trail/log', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = logSchema.parse(req.body);
    const entry = await svc.logAction(req.auth!.userId, data);
    reply.status(201);
    return entry;
  });

  app.get('/api/audit-trail/resource/:resourceType/:resourceId', { preHandler: [app.requireAuth] }, async (req) => {
    const { resourceType, resourceId } = req.params as { resourceType: string; resourceId: string };
    return svc.getByResource(req.auth!.userId, resourceType, resourceId);
  });

  app.get('/api/audit-trail/:id/verify', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.verifyIntegrity(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'entry_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/audit-trail/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getEntry(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'entry_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
