import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentRetryPolicyService } from '../../kopera/services/payment-retry-policy.js';

export async function registerPaymentRetryPolicyRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentRetryPolicyService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    maxRetries: z.number().int().min(1),
    retryIntervalMinutes: z.number().int().min(1),
    backoffMultiplier: z.number().min(1),
    applicableMethods: z.string().min(1),
  });

  app.get('/api/payment-retry-policies/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPolicyAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-retry-policies/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPolicies(req.auth!.userId);
  });

  app.post('/api/payment-retry-policies/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const p = await svc.createPolicy(req.auth!.userId, data);
      reply.status(201);
      return p;
    } catch (e: any) {
      if (e.message === 'policy_name_duplicate') { reply.status(409); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-retry-policies/:id/record', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { success } = z.object({ success: z.boolean() }).parse(req.body);
    try {
      return await svc.recordRetry(req.auth!.userId, id, success);
    } catch (e: any) {
      if (e.message === 'policy_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'policy_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-retry-policies/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      return await svc.togglePolicy(req.auth!.userId, id, active);
    } catch (e: any) {
      if (e.message === 'policy_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-retry-policies/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deletePolicy(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'policy_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-retry-policies/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getPolicy(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'policy_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
