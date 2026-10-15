import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ExchangeOrderService } from '../../kopera/services/exchange-order.js';

export async function registerExchangeOrderRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ExchangeOrderService(prisma);

  const createSchema = z.object({
    fromCurrency: z.string().length(3),
    toCurrency: z.string().length(3),
    fromAmount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    exchangeRate: z.number().positive(),
    orderType: z.enum(['MARKET', 'LIMIT']),
  });

  const serialize = (o: any) => ({
    ...o,
    fromAmount: o.fromAmount?.toString(),
    toAmount: o.toAmount?.toString(),
  });

  app.get('/api/exchange-orders/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getExchangeAnalytics(req.auth!.userId);
  });

  app.get('/api/exchange-orders/list', { preHandler: [app.requireAuth] }, async (req) => {
    const orders = await svc.getOrders(req.auth!.userId);
    return (orders as any[]).map(serialize);
  });

  app.post('/api/exchange-orders/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const order = await svc.createOrder(req.auth!.userId, data);
    reply.status(201);
    return serialize(order);
  });

  app.post('/api/exchange-orders/:id/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.executeOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'order_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'order_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/exchange-orders/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.cancelOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'order_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'order_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/exchange-orders/pair/:fromCurrency/:toCurrency', { preHandler: [app.requireAuth] }, async (req) => {
    const { fromCurrency, toCurrency } = req.params as { fromCurrency: string; toCurrency: string };
    const orders = await svc.getOrdersByPair(req.auth!.userId, fromCurrency, toCurrency);
    return (orders as any[]).map(serialize);
  });

  app.get('/api/exchange-orders/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await svc.getOrder(req.auth!.userId, id);
      return serialize(order);
    } catch (e: any) {
      if (e.message === 'order_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
