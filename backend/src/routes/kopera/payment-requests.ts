import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentRequestService } from '../../kopera/services/payment-request.js';

export async function registerPaymentRequestRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentRequestService(prisma);

  const createSchema = z.object({
    payerName: z.string().min(1),
    payerEmail: z.string().email(),
    amount: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    description: z.string().min(1),
    expiresAt: z.string().datetime().optional(),
  });

  const serialize = (pr: any) => ({
    ...pr,
    amount: pr.amount?.toString(),
  });

  app.get('/api/payment-requests/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRequestAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-requests/list', { preHandler: [app.requireAuth] }, async (req) => {
    const reqs = await svc.getRequests(req.auth!.userId);
    return (reqs as any[]).map(serialize);
  });

  app.post('/api/payment-requests/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const pr = await svc.createRequest(req.auth!.userId, {
      payerName: data.payerName,
      payerEmail: data.payerEmail,
      amount: data.amount,
      currency: data.currency,
      description: data.description,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
    });
    reply.status(201);
    return serialize(pr);
  });

  app.post('/api/payment-requests/:id/mark-paid', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const pr = await svc.markPaid(req.auth!.userId, id);
      return serialize(pr);
    } catch (e: any) {
      if (e.message === 'payment_request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-requests/:id/decline', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const pr = await svc.declineRequest(req.auth!.userId, id);
      return serialize(pr);
    } catch (e: any) {
      if (e.message === 'payment_request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-requests/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const pr = await svc.cancelRequest(req.auth!.userId, id);
      return serialize(pr);
    } catch (e: any) {
      if (e.message === 'payment_request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-requests/:id/remind', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const pr = await svc.remindPayer(req.auth!.userId, id);
      return serialize(pr);
    } catch (e: any) {
      if (e.message === 'payment_request_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'request_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-requests/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const pr = await svc.getRequest(req.auth!.userId, id);
      return serialize(pr);
    } catch (e: any) {
      if (e.message === 'payment_request_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
