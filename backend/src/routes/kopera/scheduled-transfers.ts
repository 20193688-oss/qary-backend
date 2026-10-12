import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ScheduledTransferService } from '../../kopera/services/scheduled-transfers.js';
import { audit } from '../../lib/audit.js';

function serialize(st: any) {
  return {
    id: st.id,
    toUserId: st.toUserId,
    currency: st.currency,
    amount: st.amount.toString(),
    frequency: st.frequency,
    description: st.description,
    status: st.status,
    nextExecutionDate: st.nextExecutionDate,
    lastExecutionDate: st.lastExecutionDate,
    executionCount: st.executionCount,
    createdAt: st.createdAt,
  };
}

export async function registerScheduledTransferRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ScheduledTransferService(prisma);

  app.post('/api/scheduled-transfers', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      toUserId: z.string().min(1),
      currency: z.string().length(3),
      amount: z.number().positive(),
      frequency: z.enum(['once', 'daily', 'weekly', 'biweekly', 'monthly']),
      description: z.string().optional(),
      startDate: z.string().datetime().optional(),
    }).parse(req.body);

    try {
      const amountCents = BigInt(Math.round(body.amount * 100));
      const st = await svc.create({
        userId: req.auth!.userId,
        toUserId: body.toUserId,
        currency: body.currency,
        amount: amountCents,
        frequency: body.frequency,
        description: body.description,
        startDate: body.startDate ? new Date(body.startDate) : undefined,
      });
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'scheduled_transfer.created',
        payload: { toUserId: body.toUserId, currency: body.currency, amount: body.amount, frequency: body.frequency },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(201).send(serialize(st));
    } catch (err: any) {
      if (err.message === 'cannot_transfer_to_self') return reply.code(400).send({ error: err.message });
      if (err.message === 'recipient_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'invalid_frequency') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/scheduled-transfers', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { status?: string };
    const list = await svc.listByUser(req.auth!.userId, { status: query.status });
    return list.map(serialize);
  });

  app.get('/api/scheduled-transfers/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const st = await svc.getById(id);
    if (!st || st.userId !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return serialize(st);
  });

  app.patch('/api/scheduled-transfers/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      amount: z.number().positive().optional(),
      frequency: z.enum(['once', 'daily', 'weekly', 'biweekly', 'monthly']).optional(),
      description: z.string().max(500).optional(),
    }).parse(req.body);

    try {
      const st = await svc.update(id, req.auth!.userId, {
        amount: body.amount !== undefined ? BigInt(Math.round(body.amount * 100)) : undefined,
        frequency: body.frequency,
        description: body.description,
      });
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'scheduled_transfer.updated',
        payload: { scheduledTransferId: id, ...body },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(st);
    } catch (err: any) {
      if (err.message === 'scheduled_transfer_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'transfer_not_editable') return reply.code(400).send({ error: err.message });
      if (err.message === 'invalid_frequency') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/scheduled-transfers/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const st = await svc.cancel(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'scheduled_transfer.cancelled',
        payload: { scheduledTransferId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(st);
    } catch (err: any) {
      if (err.message === 'scheduled_transfer_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_cancelled') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/scheduled-transfers/:id/pause', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const st = await svc.pause(id, req.auth!.userId);
      return serialize(st);
    } catch (err: any) {
      if (err.message === 'scheduled_transfer_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'not_active') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/scheduled-transfers/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const st = await svc.resume(id, req.auth!.userId);
      return serialize(st);
    } catch (err: any) {
      if (err.message === 'scheduled_transfer_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'not_paused') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/scheduled-transfers/process-due', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const result = await svc.processDueTransfers();

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'system', eventType: 'scheduled_transfer.batch_processed',
      payload: { processed: result.processed },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send(result);
  });
}
