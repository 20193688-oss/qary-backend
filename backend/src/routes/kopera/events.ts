import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { EventService } from '../../kopera/services/events.js';

function serialize(e: any) {
  return {
    id: e.id,
    userId: e.userId,
    actor: e.actor,
    eventType: e.eventType,
    payload: e.payload,
    requestId: e.requestId,
    ip: e.ip,
    userAgent: e.userAgent,
    agentId: e.agentId,
    severity: e.severity,
    createdAt: e.createdAt,
  };
}

export async function registerEventRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new EventService(prisma);

  app.get('/api/events', { preHandler: [app.requireAuth] }, async (req) => {
    const q = z.object({
      eventType: z.string().optional(),
      actor: z.string().optional(),
      severity: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);

    const events = await svc.list({ userId: req.auth!.userId, ...q });
    return events.map(serialize);
  });

  app.get('/api/events/stats', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.countByType(req.auth!.userId);
  });

  app.get('/api/events/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const event = await svc.getById(id);
    if (!event) return reply.code(404).send({ error: 'not_found' });
    if (event.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return serialize(event);
  });

  app.get('/api/events/request/:requestId', { preHandler: [app.requireAuth] }, async (req) => {
    const { requestId } = req.params as { requestId: string };
    const events = await svc.listByRequest(requestId);
    return events.filter((e: any) => e.userId === req.auth!.userId).map(serialize);
  });

  app.post('/api/events', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      actor: z.string().min(1),
      eventType: z.string().min(1),
      payload: z.record(z.unknown()).default({}),
      requestId: z.string().optional(),
      ip: z.string().optional(),
      userAgent: z.string().optional(),
      agentId: z.string().optional(),
      severity: z.enum(['INFO', 'WARNING', 'CRITICAL', 'EMERGENCY']).optional(),
    }).parse(req.body);

    const event = await svc.log({ userId: req.auth!.userId, ...body, payload: body.payload as Prisma.InputJsonValue });
    return reply.code(201).send(serialize(event));
  });
}
