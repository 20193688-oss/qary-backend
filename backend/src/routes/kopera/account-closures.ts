import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AccountClosureService } from '../../kopera/services/account-closure.js';

export async function registerAccountClosureRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new AccountClosureService(prisma);

  const createSchema = z.object({
    reason: z.string().min(1),
    feedbackMessage: z.string().optional(),
  });

  const serialize = (r: any) => ({ ...r });

  app.get('/api/account-closures/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getClosureAnalytics(req.auth!.userId);
  });

  app.get('/api/account-closures/list', { preHandler: [app.requireAuth] }, async (req) => {
    const requests = await svc.getRequests(req.auth!.userId);
    return (requests as any[]).map(serialize);
  });

  app.post('/api/account-closures/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createRequest(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/account-closures/:id/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.approveRequest(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-closures/:id/process', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.processRequest(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_approved') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-closures/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.cancelRequest(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/account-closures/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getRequest(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'request_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
