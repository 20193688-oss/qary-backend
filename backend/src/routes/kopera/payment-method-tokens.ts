import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentMethodTokenService } from '../../kopera/services/payment-method-token.js';

export async function registerPaymentMethodTokenRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentMethodTokenService(prisma);

  const createSchema = z.object({
    methodType: z.string().min(1),
    lastFour: z.string().length(4),
    expiryMonth: z.number().int().min(1).max(12),
    expiryYear: z.number().int().min(2024),
    billingCountry: z.string().min(2).max(3),
  });

  app.get('/api/payment-method-tokens/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTokenAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-method-tokens/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTokens(req.auth!.userId);
  });

  app.post('/api/payment-method-tokens/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const { record, token } = await svc.createToken(req.auth!.userId, data);
    reply.status(201);
    return { ...record, token };
  });

  app.post('/api/payment-method-tokens/:id/use', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.useToken(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'token_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'token_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-method-tokens/:id/deactivate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.deactivateToken(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'token_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'token_already_inactive') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-method-tokens/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteToken(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'token_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-method-tokens/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getToken(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'token_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
