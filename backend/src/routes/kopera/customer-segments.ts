import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { CustomerSegmentService } from '../../kopera/services/customer-segment.js';

export async function registerCustomerSegmentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new CustomerSegmentService(prisma);

  const createSchema = z.object({
    name: z.string().min(1),
    criteria: z.string().min(1),
    description: z.string().optional(),
  });

  const serialize = (s: any) => ({ ...s });

  app.get('/api/customer-segments/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSegmentAnalytics(req.auth!.userId);
  });

  app.get('/api/customer-segments/list', { preHandler: [app.requireAuth] }, async (req) => {
    const segments = await svc.getSegments(req.auth!.userId);
    return (segments as any[]).map(serialize);
  });

  app.post('/api/customer-segments/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const s = await svc.createSegment(req.auth!.userId, data);
      reply.status(201);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'segment_exists') { reply.status(409); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/customer-segments/:id/add-members', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { count } = z.object({ count: z.number().int().positive() }).parse(req.body);
    try {
      const s = await svc.addMembers(req.auth!.userId, id, count);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'segment_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'segment_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/customer-segments/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const s = await svc.toggleSegment(req.auth!.userId, id, active);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'segment_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/customer-segments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.deleteSegment(req.auth!.userId, id);
      return { success: true };
    } catch (e: any) {
      if (e.message === 'segment_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/customer-segments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await svc.getSegment(req.auth!.userId, id);
      return serialize(s);
    } catch (e: any) {
      if (e.message === 'segment_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
