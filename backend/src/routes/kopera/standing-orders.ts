import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { StandingOrderService } from '../../kopera/services/standing-order.js';

export async function registerStandingOrderRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new StandingOrderService(prisma);

  const createSchema = z.object({
    recipientName: z.string().min(1),
    recipientAccount: z.string().min(1),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    startDate: z.string().transform((v) => new Date(v)),
    description: z.string().optional(),
  });

  const serialize = (o: any) => ({ ...o, amount: o.amount?.toString() });

  app.get('/api/standing-orders/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getOrderAnalytics(req.auth!.userId);
  });

  app.get('/api/standing-orders/list', { preHandler: [app.requireAuth] }, async (req) => {
    const orders = await svc.getOrders(req.auth!.userId);
    return (orders as any[]).map(serialize);
  });

  app.post('/api/standing-orders/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const order = await svc.createOrder(req.auth!.userId, data);
    reply.status(201);
    return serialize(order);
  });

  app.post('/api/standing-orders/:id/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.executeOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'standing_order_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'order_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/standing-orders/:id/pause', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.pauseOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'standing_order_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'order_not_active') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/standing-orders/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.resumeOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'standing_order_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'order_not_paused') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/standing-orders/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.cancelOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'standing_order_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'order_already_cancelled') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/standing-orders/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.getOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'standing_order_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
