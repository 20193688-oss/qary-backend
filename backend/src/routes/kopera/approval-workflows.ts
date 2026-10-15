import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ApprovalWorkflowService } from '../../kopera/services/approval-workflow.js';

export async function registerApprovalWorkflowRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ApprovalWorkflowService(prisma);

  const createSchema = z.object({
    requestType: z.string().min(1).max(100),
    resourceType: z.string().min(1).max(100),
    resourceId: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
    currency: z.string().length(3).optional(),
    description: z.string().min(1).max(1000),
    requiredApprovals: z.number().int().min(1).max(10).optional(),
  });

  const approveSchema = z.object({ notes: z.string().max(500).optional() });
  const rejectSchema = z.object({ reason: z.string().min(1).max(500) });

  app.get('/api/approval-workflows/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getApprovalAnalytics(req.auth!.userId);
  });

  app.get('/api/approval-workflows/list', { preHandler: [app.requireAuth] }, async (req) => {
    const requests = await svc.getRequests(req.auth!.userId);
    return (requests as any[]).map((r) => ({
      ...r,
      amount: r.amount?.toString() ?? null,
    }));
  });

  app.post('/api/approval-workflows/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const request = await svc.createRequest(req.auth!.userId, data);
    reply.status(201);
    return { ...request, amount: (request as any).amount?.toString() ?? null };
  });

  app.post('/api/approval-workflows/:id/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = approveSchema.parse(req.body);
    try {
      const result = await svc.approve(req.auth!.userId, id, data.notes);
      return { ...result, amount: (result as any).amount?.toString() ?? null };
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/approval-workflows/:id/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = rejectSchema.parse(req.body);
    try {
      const result = await svc.reject(req.auth!.userId, id, data.reason);
      return { ...result, amount: (result as any).amount?.toString() ?? null };
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/approval-workflows/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await svc.cancel(req.auth!.userId, id);
      return { ...result, amount: (result as any).amount?.toString() ?? null };
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/approval-workflows/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const request = await svc.getRequest(req.auth!.userId, id);
      return { ...request, amount: (request as any).amount?.toString() ?? null };
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
