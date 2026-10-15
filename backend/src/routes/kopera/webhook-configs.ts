import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { WebhookConfigService } from '../../kopera/services/webhook-config.js';

export async function registerWebhookConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new WebhookConfigService(prisma);

  const createSchema = z.object({
    url: z.string().url(),
    events: z.array(z.string().min(1)).min(1).max(50),
    description: z.string().max(500).optional(),
  });

  const updateSchema = z.object({
    url: z.string().url().optional(),
    events: z.array(z.string().min(1)).min(1).max(50).optional(),
    description: z.string().max(500).optional(),
  });

  const deliverySchema = z.object({
    eventType: z.string().min(1),
    payload: z.string().min(1),
    statusCode: z.number().int(),
    success: z.boolean(),
    responseTime: z.number().int().nonnegative(),
  });

  app.get('/api/webhook-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getWebhookAnalytics(req.auth!.userId);
  });

  app.get('/api/webhook-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getWebhooks(req.auth!.userId);
  });

  app.post('/api/webhook-configs/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const webhook = await svc.createWebhook(req.auth!.userId, data);
      reply.status(201);
      return webhook;
    } catch (e: any) {
      if (e.message === 'max_webhooks_reached' || e.message === 'webhook_url_exists') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/webhook-configs/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      return await svc.updateWebhook(req.auth!.userId, id, data);
    } catch (e: any) {
      if (e.message === 'webhook_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/webhook-configs/:id/deactivate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.deactivateWebhook(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'webhook_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/webhook-configs/:id/rotate-secret', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.rotateSecret(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'webhook_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/webhook-configs/:id/delivery', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = deliverySchema.parse(req.body);
    try {
      const delivery = await svc.recordDelivery(req.auth!.userId, id, data);
      reply.status(201);
      return delivery;
    } catch (e: any) {
      if (e.message === 'webhook_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/webhook-configs/:id/deliveries', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getDeliveryLog(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'webhook_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/webhook-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getWebhook(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'webhook_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
