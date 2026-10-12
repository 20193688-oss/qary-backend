import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { WalletService } from '../../kopera/services/wallet.js';
import { PointsService } from '../../kopera/services/points.js';
import { audit } from '../../lib/audit.js';

export async function registerWalletRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const wallets = new WalletService(prisma);
  const pointsSvc = new PointsService(prisma);

  async function earnPoints(userId: string, amountCents: number, type: string, txnId: string) {
    try {
      const balance = await pointsSvc.getBalance(userId);
      const pts = pointsSvc.pointsForTransaction(amountCents, type, balance.tier);
      if (pts > 0) await pointsSvc.earn(userId, pts, `${type} reward`, txnId);
    } catch { /* best-effort */ }
  }

  app.get('/api/wallets', { preHandler: [app.requireAuth] }, async (req) => {
    return wallets.getAllBalances(req.auth!.userId);
  });

  app.get('/api/wallets/:currency', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { currency } = req.params as { currency: string };
    const balance = await wallets.getBalance(req.auth!.userId, currency);
    if (!balance) return reply.code(404).send({ error: 'wallet_not_found' });
    return balance;
  });

  app.post('/api/wallets', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      currency: z.string().length(3),
    }).parse(req.body);
    const wallet = await wallets.getOrCreateWallet(req.auth!.userId, body.currency);
    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'wallet.created',
      payload: { currency: body.currency }, requestId: String(req.id), ip: req.ip,
    });
    return reply.code(201).send(serializeWallet(wallet));
  });

  app.post('/api/wallets/deposit', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      currency: z.string().length(3),
      amount: z.number().positive(),
      description: z.string().optional(),
    }).parse(req.body);

    const amountCents = BigInt(Math.round(body.amount * 100));
    const result = await wallets.deposit(req.auth!.userId, body.currency, amountCents, body.description);
    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'wallet.deposit',
      payload: { currency: body.currency, amount: body.amount }, requestId: String(req.id), ip: req.ip,
    });
    await earnPoints(req.auth!.userId, Number(amountCents), 'DEPOSIT', result.transaction.id);
    return reply.send({
      transactionId: result.transaction.id,
      reference: result.transaction.reference,
      balance: result.wallet.balance.toString(),
      available: result.wallet.availableBalance.toString(),
    });
  });

  app.post('/api/wallets/withdraw', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      currency: z.string().length(3),
      amount: z.number().positive(),
      description: z.string().optional(),
    }).parse(req.body);

    const amountCents = BigInt(Math.round(body.amount * 100));
    try {
      const result = await wallets.withdraw(req.auth!.userId, body.currency, amountCents, body.description);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'wallet.withdraw',
        payload: { currency: body.currency, amount: body.amount }, requestId: String(req.id), ip: req.ip,
      });
      return reply.send({
        transactionId: result.transaction.id,
        reference: result.transaction.reference,
        balance: result.wallet.balance.toString(),
        available: result.wallet.availableBalance.toString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'insufficient_funds') return reply.code(400).send({ error: msg });
      if (msg === 'wallet_not_found') return reply.code(404).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/wallets/transfer', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      toUserId: z.string().min(1),
      currency: z.string().length(3),
      amount: z.number().positive(),
      description: z.string().optional(),
    }).parse(req.body);

    const amountCents = BigInt(Math.round(body.amount * 100));
    try {
      const result = await wallets.transfer(
        req.auth!.userId, body.toUserId, body.currency, amountCents, body.description,
      );
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'wallet.transfer',
        payload: { toUserId: body.toUserId, currency: body.currency, amount: body.amount },
        requestId: String(req.id), ip: req.ip,
      });
      await earnPoints(req.auth!.userId, Number(amountCents), 'TRANSFER', result.transaction.id);
      return reply.send({
        transactionId: result.transaction.id,
        reference: result.transaction.reference,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (['insufficient_funds', 'sender_wallet_frozen', 'receiver_wallet_frozen'].includes(msg)) {
        return reply.code(400).send({ error: msg });
      }
      if (msg.includes('not_found')) return reply.code(404).send({ error: msg });
      throw err;
    }
  });

  app.get('/api/transactions', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; type?: string };
    const txns = await prisma.transaction.findMany({
      where: {
        userId: req.auth!.userId,
        ...(query.type ? { type: query.type as any } : {}),
      },
      take: Math.min(Number(query.limit ?? 20), 100),
      skip: Number(query.offset ?? 0),
      orderBy: { createdAt: 'desc' },
    });
    return txns.map(serializeTransaction);
  });
}

function serializeWallet(w: any) {
  return {
    id: w.id,
    currency: w.currency,
    balance: w.balance.toString(),
    availableBalance: w.availableBalance.toString(),
    holdBalance: w.holdBalance.toString(),
    status: w.status,
    isDefault: w.isDefault,
  };
}

function serializeTransaction(t: any) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    amount: t.amount.toString(),
    currency: t.currency,
    feeAmount: t.feeAmount.toString(),
    fxRate: t.fxRate,
    description: t.description,
    reference: t.reference,
    createdAt: t.createdAt,
  };
}
