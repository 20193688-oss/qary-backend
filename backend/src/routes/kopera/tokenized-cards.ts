import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TokenizedCardService } from '../../kopera/services/tokenized-cards.js';
import { audit } from '../../lib/audit.js';

function serialize(c: any) {
  return {
    id: c.id,
    last4: c.last4,
    network: c.network,
    expiryMonth: c.expiryMonth,
    expiryYear: c.expiryYear,
    holderName: c.holderName,
    isDefault: c.isDefault,
    frozen: c.frozen ?? false,
    country: c.country,
    bankName: c.bankName,
    createdAt: c.createdAt,
  };
}

export async function registerTokenizedCardRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TokenizedCardService(prisma);

  app.post('/api/cards', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      vaultToken: z.string().min(1),
      last4: z.string().length(4),
      network: z.enum(['VISA', 'MASTERCARD', 'AMEX', 'DINERS', 'UNIONPAY', 'DISCOVER', 'JCB']),
      expiryMonth: z.number().int().min(1).max(12),
      expiryYear: z.number().int().min(2024),
      holderName: z.string().optional(),
      country: z.string().length(2).optional(),
      bankName: z.string().optional(),
      fingerprint: z.string().optional(),
    }).parse(req.body);

    try {
      const card = await svc.addCard(req.auth!.userId, body);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'card.added',
        payload: { last4: body.last4, network: body.network },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(201).send(serialize(card));
    } catch (err: any) {
      if (err.message === 'card_already_exists') return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/cards', { preHandler: [app.requireAuth] }, async (req) => {
    const cards = await svc.listCards(req.auth!.userId);
    return cards.map(serialize);
  });

  app.get('/api/cards/stats', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCardStats(req.auth!.userId);
  });

  app.get('/api/cards/usage-analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getUsageAnalytics(req.auth!.userId);
  });

  app.get('/api/cards/expiry-forecast', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getExpiryForecast(req.auth!.userId);
  });

  app.get('/api/cards/network-diversification', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getNetworkDiversification(req.auth!.userId);
  });

  app.get('/api/cards/security-posture', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSecurityPosture(req.auth!.userId);
  });

  app.get('/api/cards/bank-distribution', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getBankDistribution(req.auth!.userId);
  });

  app.get('/api/cards/token-lifecycle-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTokenLifecycleAnalysis(req.auth!.userId);
  });

  app.get('/api/cards/spending-by-card', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSpendingByCard(req.auth!.userId);
  });

  app.get('/api/cards/fraud-risk-assessment', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCardFraudRiskAssessment(req.auth!.userId);
  });

  app.get('/api/cards/utilization-trend', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCardUtilizationTrend(req.auth!.userId);
  });

  app.get('/api/cards/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await svc.getCard(id);
    if (!card || card.userId !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return serialize(card);
  });

  app.post('/api/cards/:id/default', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const card = await svc.setDefault(id, req.auth!.userId);
      return serialize(card);
    } catch (err: any) {
      if (err.message === 'card_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });

  app.put('/api/cards/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      expiryMonth: z.number().int().min(1).max(12).optional(),
      expiryYear: z.number().int().min(2024).optional(),
      holderName: z.string().min(1).optional(),
    }).parse(req.body);

    try {
      const card = await svc.updateCard(id, req.auth!.userId, body);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'card.updated',
        payload: { cardId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(card);
    } catch (err: any) {
      if (err.message === 'card_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/cards/:id/freeze', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const card = await svc.freezeCard(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'card.frozen',
        payload: { cardId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(card);
    } catch (err: any) {
      if (err.message === 'card_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_frozen') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/cards/:id/unfreeze', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const card = await svc.unfreezeCard(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'card.unfrozen',
        payload: { cardId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(card);
    } catch (err: any) {
      if (err.message === 'card_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'not_frozen') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/cards/expiring', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { months?: string };
    const months = Number(query.months ?? 2);
    const cards = await svc.checkExpiringCards(months);
    const userCards = cards.filter((c: any) => c.userId === req.auth!.userId);
    return userCards.map(serialize);
  });

  app.delete('/api/cards/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.removeCard(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'card.removed',
        payload: { cardId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(204).send();
    } catch (err: any) {
      if (err.message === 'card_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });
}
