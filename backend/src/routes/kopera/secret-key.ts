import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { SecretKeyService } from '../../kopera/services/secret-key.js';

export async function registerSecretKeyRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new SecretKeyService(prisma);

  const createSchema = z.object({
    secretKey: z.string().min(6).max(32),
    label: z.string().max(100).optional(),
  });

  const validateSchema = z.object({
    secretKey: z.string().min(1),
  });

  const rotateSchema = z.object({
    newSecretKey: z.string().min(6).max(32),
  });

  app.get('/api/secret-keys/report', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getKeySecurityReport(req.auth!.userId);
  });

  app.get('/api/secret-keys/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getKeys(req.auth!.userId);
  });

  app.post('/api/secret-keys/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const key = await svc.createKey(req.auth!.userId, data);
      reply.status(201);
      return { id: (key as any).id, label: (key as any).label, isActive: (key as any).isActive };
    } catch (e: any) {
      if (e.message === 'key_too_short' || e.message === 'key_too_long' || e.message === 'max_keys_reached') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/secret-keys/validate', { preHandler: [app.requireAuth] }, async (req) => {
    const data = validateSchema.parse(req.body);
    return svc.validateKey(req.auth!.userId, data.secretKey);
  });

  app.post('/api/secret-keys/:id/revoke', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const key = await svc.revokeKey(req.auth!.userId, id);
      return { id: (key as any).id, isActive: (key as any).isActive };
    } catch (e: any) {
      if (e.message === 'key_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'key_already_revoked') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/secret-keys/:id/rotate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = rotateSchema.parse(req.body);
    try {
      const key = await svc.rotateKey(req.auth!.userId, id, data.newSecretKey);
      return { id: (key as any).id, label: (key as any).label };
    } catch (e: any) {
      if (e.message === 'key_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (['key_too_short', 'key_too_long', 'key_already_revoked'].includes(e.message)) {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });
}
