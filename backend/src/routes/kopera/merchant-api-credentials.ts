import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantApiCredentialService } from '../../kopera/services/merchant-api-credential.js';

export async function registerMerchantApiCredentialRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantApiCredentialService(prisma);

  const createSchema = z.object({
    merchantId: z.string().min(1),
    label: z.string().min(1),
    environment: z.string().min(1),
    permissions: z.string().min(1),
  });

  app.get('/api/merchant-api-credentials/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCredentialAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-api-credentials/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCredentials(req.auth!.userId);
  });

  app.post('/api/merchant-api-credentials/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const { record, apiKey, apiSecret } = await svc.createCredential(req.auth!.userId, data);
    reply.status(201);
    return { ...record, apiKey, apiSecret };
  });

  app.post('/api/merchant-api-credentials/:id/record-usage', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.recordUsage(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'credential_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'credential_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-api-credentials/:id/revoke', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.revokeCredential(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'credential_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'credential_already_revoked') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/merchant-api-credentials/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteCredential(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'credential_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-api-credentials/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getCredential(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'credential_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
