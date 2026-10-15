import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { RateLimitConfigService } from '../../kopera/services/rate-limit-config.js';

export async function registerRateLimitConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new RateLimitConfigService(prisma);

  const setSchema = z.object({
    endpoint: z.string().min(1).max(200),
    maxRequests: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
    strategy: z.enum(['fixed_window', 'sliding_window', 'token_bucket']).optional(),
  });

  const toggleSchema = z.object({
    active: z.boolean(),
  });

  const checkSchema = z.object({
    endpoint: z.string().min(1),
  });

  app.get('/api/rate-limit-configs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRateLimitAnalytics(req.auth!.userId);
  });

  app.get('/api/rate-limit-configs/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getLimits(req.auth!.userId);
  });

  app.post('/api/rate-limit-configs/set', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = setSchema.parse(req.body);
    const config = await svc.setLimit(req.auth!.userId, data);
    reply.status(201);
    return config;
  });

  app.post('/api/rate-limit-configs/check', { preHandler: [app.requireAuth] }, async (req) => {
    const data = checkSchema.parse(req.body);
    return svc.checkLimit(req.auth!.userId, data.endpoint);
  });

  app.post('/api/rate-limit-configs/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = toggleSchema.parse(req.body);
    try {
      return await svc.toggleLimit(req.auth!.userId, id, data.active);
    } catch (e: any) {
      if (e.message === 'rate_limit_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/rate-limit-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.removeLimit(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'rate_limit_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/rate-limit-configs/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getLimit(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'rate_limit_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
