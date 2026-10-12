import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionService } from '../../kopera/services/transactions.js';

function serialize(t: any) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    amount: t.amount?.toString(),
    currency: t.currency,
    feeAmount: t.feeAmount?.toString(),
    description: t.description,
    reference: t.reference,
    senderWalletId: t.senderWalletId,
    receiverWalletId: t.receiverWalletId,
    counterpartyName: t.counterpartyName,
    paymentMethodUsed: t.paymentMethodUsed,
    createdAt: t.createdAt,
    processedAt: t.processedAt,
  };
}

export async function registerTransactionRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionService(prisma);

  app.get('/api/transaction-history', { preHandler: [app.requireAuth] }, async (req) => {
    const q = z.object({
      type: z.string().optional(),
      status: z.string().optional(),
      currency: z.string().length(3).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);

    const result = await svc.listTransactions(req.auth!.userId, {
      ...q,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return { data: result.rows.map(serialize), total: result.total };
  });

  app.get('/api/transaction-history/export', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const q = z.object({
      currency: z.string().length(3).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }).parse(req.query);

    const result = await svc.listTransactions(req.auth!.userId, {
      currency: q.currency,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: 10000,
      offset: 0,
    });

    const header = 'id,type,status,amount,currency,fee,description,reference,date\n';
    const rows = result.rows.map((t: any) =>
      `${t.id},${t.type},${t.status},${t.amount},${t.currency},${t.feeAmount ?? 0},"${(t.description ?? '').replace(/"/g, '""')}",${t.reference ?? ''},${t.createdAt ? new Date(t.createdAt).toISOString() : ''}`,
    ).join('\n');

    return reply
      .header('content-type', 'text/csv')
      .header('content-disposition', 'attachment; filename="transactions.csv"')
      .send(header + rows);
  });

  app.get('/api/transaction-history/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const txn = await svc.getTransaction(id, req.auth!.userId);
    if (!txn) return reply.code(404).send({ error: 'not_found' });
    return serialize(txn);
  });

  app.get('/api/transaction-history/reference/:ref', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const txn = await svc.getByReference(ref, req.auth!.userId);
    if (!txn) return reply.code(404).send({ error: 'not_found' });
    return serialize(txn);
  });

  app.get('/api/transaction-history/summary/:currency', { preHandler: [app.requireAuth] }, async (req) => {
    const { currency } = req.params as { currency: string };
    const summary = await svc.getSummary(req.auth!.userId, currency);
    return {
      currency: summary.currency,
      totalIn: summary.totalIn.toString(),
      totalOut: summary.totalOut.toString(),
      count: summary.count,
    };
  });
}
