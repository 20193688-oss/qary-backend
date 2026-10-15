import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { WebhookEventLogService } from '../../kopera/services/webhook-event-log.js';

export async function registerWebhookEventLogRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new WebhookEventLogService(prisma);

  const createSchema = z.object({
    webhookConfigId: z.string().min(1),
    eventType: z.string().min(1),
    payload: z.string().min(1),
    targetUrl: z.string().url(),
  });

  const attemptSchema = z.object({
    responseCode: z.number().int(),
    responseBody: z.string(),
  });

  app.get('/api/webhook-event-logs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getLogAnalytics(req.auth!.userId);
  });

  app.get('/api/webhook-event-logs/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getLogs(req.auth!.userId);
  });

  app.post('/api/webhook-event-logs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const l = await svc.createLog(req.auth!.userId, data);
    reply.status(201);
    return l;
  });

  app.post('/api/webhook-event-logs/:id/attempt', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = attemptSchema.parse(req.body);
    try {
      return await svc.recordAttempt(req.auth!.userId, id, data);
    } catch (e: any) {
      if (e.message === 'log_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/webhook-event-logs/:id/retry', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.retryLog(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'log_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'log_not_failed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/webhook-event-logs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getLog(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'log_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
