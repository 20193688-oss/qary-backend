import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { MerchantOnboardingService } from '../../kopera/services/merchant-onboarding.js';

export async function registerMerchantOnboardingRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new MerchantOnboardingService(prisma);

  const createSchema = z.object({
    businessName: z.string().min(1),
    businessType: z.string().min(1),
    contactEmail: z.string().email(),
    country: z.string().min(2),
  });

  const serialize = (a: any) => ({ ...a });

  app.get('/api/merchant-onboarding/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getOnboardingAnalytics(req.auth!.userId);
  });

  app.get('/api/merchant-onboarding/list', { preHandler: [app.requireAuth] }, async (req) => {
    const apps = await svc.getApplications(req.auth!.userId);
    return (apps as any[]).map(serialize);
  });

  app.post('/api/merchant-onboarding/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const a = await svc.createApplication(req.auth!.userId, data);
    reply.status(201);
    return serialize(a);
  });

  app.post('/api/merchant-onboarding/:id/advance', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const a = await svc.advanceStep(req.auth!.userId, id);
      return serialize(a);
    } catch (e: any) {
      if (e.message === 'application_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'application_not_in_progress') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-onboarding/:id/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const a = await svc.approveApplication(req.auth!.userId, id);
      return serialize(a);
    } catch (e: any) {
      if (e.message === 'application_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'application_not_completed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/merchant-onboarding/:id/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    try {
      const a = await svc.rejectApplication(req.auth!.userId, id, reason);
      return serialize(a);
    } catch (e: any) {
      if (e.message === 'application_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'application_already_resolved') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/merchant-onboarding/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const a = await svc.getApplication(req.auth!.userId, id);
      return serialize(a);
    } catch (e: any) {
      if (e.message === 'application_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
