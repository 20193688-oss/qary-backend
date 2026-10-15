import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PayoutMethodService } from '../../kopera/services/payout-method.js';

export async function registerPayoutMethodRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PayoutMethodService(prisma);

  const addSchema = z.object({
    methodType: z.enum(['BANK_TRANSFER', 'MOBILE_MONEY', 'CRYPTO', 'PAYPAL']),
    provider: z.string().min(1),
    accountIdentifier: z.string().min(1),
    currency: z.string().length(3),
    label: z.string().optional(),
  });

  app.get('/api/payout-methods/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPayoutAnalytics(req.auth!.userId);
  });

  app.get('/api/payout-methods/list', { preHandler: [app.requireAuth] }, async (req) => {
    const methods = await svc.getMethods(req.auth!.userId);
    return methods;
  });

  app.post('/api/payout-methods/add', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = addSchema.parse(req.body);
    try {
      const method = await svc.addMethod(req.auth!.userId, data);
      reply.status(201);
      return method;
    } catch (e: any) {
      if (e.message === 'payout_method_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payout-methods/:id/verify', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const method = await svc.verifyMethod(req.auth!.userId, id);
      return method;
    } catch (e: any) {
      if (e.message === 'payout_method_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'payout_method_already_verified') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payout-methods/:id/set-default', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const method = await svc.setDefault(req.auth!.userId, id);
      return method;
    } catch (e: any) {
      if (e.message === 'payout_method_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payout-methods/:id/disable', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const method = await svc.disableMethod(req.auth!.userId, id);
      return method;
    } catch (e: any) {
      if (e.message === 'payout_method_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'payout_method_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payout-methods/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const method = await svc.deleteMethod(req.auth!.userId, id);
      return method;
    } catch (e: any) {
      if (e.message === 'payout_method_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payout-methods/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const method = await svc.getMethod(req.auth!.userId, id);
      return method;
    } catch (e: any) {
      if (e.message === 'payout_method_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
