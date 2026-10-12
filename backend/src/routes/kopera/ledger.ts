import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { LedgerService } from '../../kopera/services/ledger.js';

function serialize(e: any) {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    amount: e.amount?.toString(),
    balanceBefore: e.balanceBefore?.toString(),
    balanceAfter: e.balanceAfter?.toString(),
    entryType: e.entryType,
    description: e.description,
    createdAt: e.createdAt,
  };
}

export async function registerLedgerRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new LedgerService(prisma);

  app.get('/api/ledger/summary', { preHandler: [app.requireAuth] }, async (req) => {
    const summary = await svc.getBalanceSummary(req.auth!.userId);
    return summary.map((w: any) => ({
      walletId: w.walletId,
      currency: w.currency,
      balance: w.balance.toString(),
      availableBalance: w.availableBalance.toString(),
      holdBalance: w.holdBalance.toString(),
      status: w.status,
    }));
  });

  app.get('/api/ledger/:walletId', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { walletId } = req.params as { walletId: string };

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) return reply.code(404).send({ error: 'wallet_not_found' });
    if (wallet.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const q = z.object({
      entryType: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);

    const entries = await svc.listByWallet(walletId, q);
    return entries.map(serialize);
  });

  app.get('/api/ledger/entry/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = await svc.getById(id);
    if (!entry) return reply.code(404).send({ error: 'not_found' });

    const wallet = await prisma.wallet.findUnique({ where: { id: entry.walletId } });
    if (!wallet || wallet.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return serialize(entry);
  });

  app.get('/api/ledger/:walletId/transaction/:transactionId', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { walletId, transactionId } = req.params as { walletId: string; transactionId: string };

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) return reply.code(404).send({ error: 'wallet_not_found' });
    if (wallet.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const entries = await svc.listByTransaction(transactionId);
    return entries.filter((e: any) => e.walletId === walletId).map(serialize);
  });

  app.get('/api/ledger/:walletId/statement', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { walletId } = req.params as { walletId: string };

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) return reply.code(404).send({ error: 'wallet_not_found' });
    if (wallet.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const q = z.object({
      from: z.string(),
      to: z.string(),
    }).parse(req.query);

    const stmt = await svc.getStatement(walletId, q.from, q.to);
    return {
      walletId: stmt.walletId,
      from: stmt.from,
      to: stmt.to,
      totalDebits: stmt.totalDebits.toString(),
      totalCredits: stmt.totalCredits.toString(),
      entryCount: stmt.entryCount,
      openingBalance: stmt.openingBalance.toString(),
      closingBalance: stmt.closingBalance.toString(),
      entries: stmt.entries.map(serialize),
    };
  });
}
