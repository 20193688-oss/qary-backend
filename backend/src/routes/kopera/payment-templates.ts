import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentTemplateService } from '../../kopera/services/payment-template.js';

export async function registerPaymentTemplateRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentTemplateService(prisma);

  const createSchema = z.object({
    name: z.string().min(1).max(100),
    recipientName: z.string().min(1).max(200),
    recipientAccount: z.string().min(1).max(100),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
    currency: z.string().length(3),
    description: z.string().max(500).optional(),
    category: z.string().max(50).optional(),
  });

  const updateSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    recipientName: z.string().min(1).max(200).optional(),
    recipientAccount: z.string().min(1).max(100).optional(),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)).optional(),
    currency: z.string().length(3).optional(),
    description: z.string().max(500).optional(),
    category: z.string().max(50).optional(),
  });

  const toggleSchema = z.object({ active: z.boolean() });

  const serialize = (t: any) => ({ ...t, amount: t.amount?.toString() ?? null });

  app.get('/api/payment-templates/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTemplateAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-templates/list', { preHandler: [app.requireAuth] }, async (req) => {
    const templates = await svc.getTemplates(req.auth!.userId);
    return (templates as any[]).map(serialize);
  });

  app.post('/api/payment-templates/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const tpl = await svc.createTemplate(req.auth!.userId, data);
    reply.status(201);
    return serialize(tpl);
  });

  app.post('/api/payment-templates/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      const tpl = await svc.updateTemplate(req.auth!.userId, id, data);
      return serialize(tpl);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-templates/:id/use', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const tpl = await svc.useTemplate(req.auth!.userId, id);
      return serialize(tpl);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'template_inactive') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-templates/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = toggleSchema.parse(req.body);
    try {
      const tpl = await svc.toggleTemplate(req.auth!.userId, id, data.active);
      return serialize(tpl);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/payment-templates/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const tpl = await svc.deleteTemplate(req.auth!.userId, id);
      return serialize(tpl);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-templates/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const tpl = await svc.getTemplate(req.auth!.userId, id);
      return serialize(tpl);
    } catch (e: any) {
      if (e.message === 'template_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
