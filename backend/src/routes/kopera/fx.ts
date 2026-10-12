import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { FxService } from '../../kopera/services/fx.js';
import { WalletService } from '../../kopera/services/wallet.js';
import { audit } from '../../lib/audit.js';

export async function registerFxRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const fx = new FxService(prisma);
  const wallets = new WalletService(prisma);

  app.get('/api/fx/rate/:pair/history', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { pair } = req.params as { pair: string };
    const [base, quote] = pair.toUpperCase().split(/[/_-]/);
    if (!base || !quote) return reply.code(400).send({ error: 'invalid_pair_format' });

    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);

    const history = await fx.getRateHistory(base, quote, { limit: q.limit });
    return history.map((r: any) => ({
      id: r.id,
      baseCurrency: r.baseCurrency,
      quoteCurrency: r.quoteCurrency,
      bid: r.bid,
      ask: r.ask,
      mid: r.mid,
      spread: r.spread,
      source: r.source,
      validFrom: r.validFrom,
    }));
  });

  app.get('/api/fx/rate/:pair', async (req, reply) => {
    const { pair } = req.params as { pair: string };
    const [base, quote] = pair.toUpperCase().split(/[/_-]/);
    if (!base || !quote) return reply.code(400).send({ error: 'invalid_pair_format' });
    const rate = await fx.getRate(base, quote);
    if (!rate) return reply.code(404).send({ error: 'rate_not_available' });
    return rate;
  });

  app.get('/api/fx/conversion-history', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await fx.getConversionHistory(req.auth!.userId);
    const byPair: Record<string, { count: number; totalSourceAmount: string; totalTargetAmount: string }> = {};
    for (const [pair, data] of Object.entries(result.byPair)) {
      byPair[pair] = {
        count: data.count,
        totalSourceAmount: data.totalSourceAmount.toString(),
        totalTargetAmount: data.totalTargetAmount.toString(),
      };
    }
    return { totalConversions: result.totalConversions, byPair };
  });

  app.get('/api/fx/pairs', async () => {
    return fx.getSupportedPairs();
  });

  app.get('/api/fx/spread-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await fx.getSpreadAnalysis(req.auth!.userId);
    const byPair: Record<string, { count: number; totalVolume: string; avgRate: number }> = {};
    for (const [pair, data] of Object.entries(result.byPair)) {
      byPair[pair] = { count: data.count, totalVolume: data.totalVolume.toString(), avgRate: data.avgRate };
    }
    return { totalConversions: result.totalConversions, totalVolume: result.totalVolume.toString(), byPair, bestRate: result.bestRate, worstRate: result.worstRate };
  });

  app.get('/api/fx/conversion-optimizer', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await fx.getConversionOptimizer(req.auth!.userId);
    return {
      totalConversions: result.totalConversions,
      totalVolume: result.totalVolume.toString(),
      pairAnalysis: result.pairAnalysis.map((p: any) => ({
        ...p,
        totalVolume: p.totalVolume.toString(),
      })),
      recommendations: result.recommendations,
    };
  });

  app.post('/api/fx/convert', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      fromCurrency: z.string().length(3),
      toCurrency: z.string().length(3),
      side: z.enum(['buy', 'sell']).default('buy'),
    }).parse(req.body);

    try {
      const result = await fx.convert(
        BigInt(Math.round(body.amount * 100)),
        body.fromCurrency,
        body.toCurrency,
        body.side,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return reply.code(400).send({ error: msg });
    }
  });

  app.post('/api/fx/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      fromCurrency: z.string().length(3),
      toCurrency: z.string().length(3),
    }).parse(req.body);

    const fromCurrency = body.fromCurrency.toUpperCase();
    const toCurrency = body.toCurrency.toUpperCase();
    const amountCents = BigInt(Math.round(body.amount * 100));

    const fromWallet = await wallets.getWallet(req.auth!.userId, fromCurrency);
    if (!fromWallet) return reply.code(404).send({ error: 'source_wallet_not_found' });
    if (fromWallet.status !== 'ACTIVE') return reply.code(400).send({ error: 'source_wallet_frozen' });
    if (fromWallet.availableBalance < amountCents) return reply.code(400).send({ error: 'insufficient_funds' });

    const rate = await fx.getRate(fromCurrency, toCurrency);
    if (!rate) return reply.code(400).send({ error: `no_rate_available_${fromCurrency}_${toCurrency}` });

    const appliedRate = rate.ask;
    const convertedAmount = BigInt(Math.round(Number(amountCents) * appliedRate));
    const reference = `FX-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const toWallet = await wallets.getOrCreateWallet(req.auth!.userId, toCurrency);

    const result = await prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.create({
        data: {
          userId: req.auth!.userId,
          type: 'FX_CONVERSION',
          status: 'COMPLETED',
          amount: amountCents,
          currency: fromCurrency,
          fxRate: appliedRate,
          fxSourceCurrency: fromCurrency,
          fxTargetCurrency: toCurrency,
          fxSourceAmount: amountCents,
          fxTargetAmount: convertedAmount,
          description: `Convert ${fromCurrency} to ${toCurrency}`,
          reference,
          senderWalletId: fromWallet.id,
          receiverWalletId: toWallet.id,
          processedAt: new Date(),
        },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: fromWallet.id,
          transactionId: txn.id,
          amount: -amountCents,
          balanceBefore: fromWallet.balance,
          balanceAfter: fromWallet.balance - amountCents,
          entryType: 'DEBIT',
          description: `FX conversion to ${toCurrency}`,
        },
      });

      await tx.wallet.update({
        where: { id: fromWallet.id },
        data: {
          balance: fromWallet.balance - amountCents,
          availableBalance: fromWallet.availableBalance - amountCents,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: toWallet.id,
          transactionId: txn.id,
          amount: convertedAmount,
          balanceBefore: toWallet.balance,
          balanceAfter: toWallet.balance + convertedAmount,
          entryType: 'CREDIT',
          description: `FX conversion from ${fromCurrency}`,
        },
      });

      await tx.wallet.update({
        where: { id: toWallet.id },
        data: {
          balance: toWallet.balance + convertedAmount,
          availableBalance: toWallet.availableBalance + convertedAmount,
        },
      });

      return txn;
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'fx.executed',
      payload: {
        transactionId: result.id,
        fromCurrency, toCurrency,
        fromAmount: body.amount, rate: appliedRate,
      },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send({
      transactionId: result.id,
      reference: result.reference,
      fromCurrency,
      toCurrency,
      fromAmount: amountCents.toString(),
      toAmount: convertedAmount.toString(),
      rate: appliedRate,
      spreadBps: rate.spreadBps,
    });
  });

  app.post('/api/fx/rates/bulk', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      pairs: z.array(z.object({
        base: z.string().length(3),
        quote: z.string().length(3),
      })).min(1).max(20),
    }).parse(req.body);

    return fx.getBulkRates(body.pairs);
  });

  app.post('/api/fx/rates', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      baseCurrency: z.string().length(3),
      quoteCurrency: z.string().length(3),
      bid: z.number().positive(),
      ask: z.number().positive(),
      source: z.string().min(1).max(100),
    }).parse(req.body);

    if (body.bid >= body.ask) return reply.code(400).send({ error: 'bid_must_be_less_than_ask' });

    const rate = await fx.storeRate(body.baseCurrency, body.quoteCurrency, body.bid, body.ask, body.source);

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'admin', eventType: 'fx.rate_stored',
      payload: { baseCurrency: body.baseCurrency, quoteCurrency: body.quoteCurrency, bid: body.bid, ask: body.ask },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send({
      id: rate.id,
      baseCurrency: rate.baseCurrency,
      quoteCurrency: rate.quoteCurrency,
      bid: rate.bid,
      ask: rate.ask,
      mid: rate.mid,
      spread: rate.spread,
      source: rate.source,
      validFrom: rate.validFrom,
    });
  });

  app.post('/api/fx/quote', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      fromCurrency: z.string().length(3),
      toCurrency: z.string().length(3),
    }).parse(req.body);

    const buyResult = await fx.convert(
      BigInt(Math.round(body.amount * 100)),
      body.fromCurrency,
      body.toCurrency,
      'buy',
    );
    const sellResult = await fx.convert(
      BigInt(Math.round(body.amount * 100)),
      body.fromCurrency,
      body.toCurrency,
      'sell',
    );

    return {
      amount: body.amount,
      fromCurrency: body.fromCurrency.toUpperCase(),
      toCurrency: body.toCurrency.toUpperCase(),
      buyRate: buyResult.rate,
      sellRate: sellResult.rate,
      buyAmount: buyResult.toAmount,
      sellAmount: sellResult.toAmount,
      spreadBps: buyResult.spreadBps,
      validForSeconds: 30,
    };
  });
}
