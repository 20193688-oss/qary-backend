import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentLinkTemplateService } from '../../kopera/services/payment-link-template.js';

export async function registerPaymentLinkTemplateRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentLinkTemplateService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    description: z.string().optional(),
    redirectUrl: z.string().url().optional(),
  });

  const serialize = (t: any) => ({
    ...t,
    amount: t.amount?.toString(),
  });

  app.get('/api/payment-link-templates/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTemplateAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-link-templates/list', { preHandler: [app.requireAuth] }, async (req) => {
    const templates = await svc.getTemplates(req.auth!.userId);
    return (templates as any[]).map(serialize);
  });

  app.post('/api/payment-link-templates/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const t = await svc.createTemplate(req.auth!.userId, data);
      reply.status(201);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'template_exists') { reply.status(409); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-link-templates/:id/use', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = await svc.useTemplate(req.auth!.userId, id);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'template_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-link-templates/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const t = await svc.toggleTemplate(req.auth!.userId, id, active);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-link-templates/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = await svc.deleteTemplate(req.auth!.userId, id);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-link-templates/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = await svc.getTemplate(req.auth!.userId, id);
      return serialize(t);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
