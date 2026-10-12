import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { FxService } from '../../kopera/services/fx.js';

export async function registerFxRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const fx = new FxService(prisma);

  app.get('/api/fx/rate/:pair', async (req, reply) => {
    const { pair } = req.params as { pair: string };
    const [base, quote] = pair.toUpperCase().split(/[/_-]/);
    if (!base || !quote) return reply.code(400).send({ error: 'invalid_pair_format' });
    const rate = await fx.getRate(base, quote);
    if (!rate) return reply.code(404).send({ error: 'rate_not_available' });
    return rate;
  });

  app.get('/api/fx/pairs', async () => {
    return fx.getSupportedPairs();
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
