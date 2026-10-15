import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ApiKeyService } from '../../kopera/services/api-key.js';

export async function registerApiKeyRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ApiKeyService(prisma);

  const createSchema = z.object({
    name: z.string().min(1).max(100),
    permissions: z.array(z.string().min(1)).min(1),
    expiresInDays: z.number().int().positive().optional(),
  });

  const validateSchema = z.object({
    apiKey: z.string().min(1),
  });

  app.get('/api/api-keys/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getApiKeyAnalytics(req.auth!.userId);
  });

  app.get('/api/api-keys/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getKeys(req.auth!.userId);
  });

  app.post('/api/api-keys/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const key = await svc.createKey(req.auth!.userId, data);
      reply.status(201);
      return key;
    } catch (e: any) {
      if (e.message === 'max_api_keys_reached') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/api-keys/validate', { preHandler: [app.requireAuth] }, async (req) => {
    const data = validateSchema.parse(req.body);
    return svc.validateKey(data.apiKey);
  });

  app.post('/api/api-keys/:id/revoke', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await svc.revokeKey(req.auth!.userId, id);
      return { ...(result as any), keyHash: undefined };
    } catch (e: any) {
      if (e.message === 'api_key_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
