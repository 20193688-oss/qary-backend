import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { BeneficiaryService } from '../../kopera/services/beneficiaries.js';
import { audit } from '../../lib/audit.js';

function serialize(b: any) {
  return {
    id: b.id,
    nickname: b.nickname,
    recipientUserId: b.recipientUserId,
    recipientEmail: b.recipientEmail,
    currency: b.currency,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export async function registerBeneficiaryRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new BeneficiaryService(prisma);

  app.post('/api/beneficiaries', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      nickname: z.string().min(1).max(100),
      recipientUserId: z.string().min(1),
      currency: z.string().length(3).optional(),
    }).parse(req.body);

    try {
      const b = await svc.create({ userId: req.auth!.userId, ...body });
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'beneficiary.created',
        payload: { recipientUserId: body.recipientUserId, nickname: body.nickname },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(201).send(serialize(b));
    } catch (err: any) {
      if (err.message === 'cannot_add_self') return reply.code(400).send({ error: err.message });
      if (err.message === 'recipient_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'beneficiary_exists') return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/beneficiaries', { preHandler: [app.requireAuth] }, async (req) => {
    const list = await svc.listByUser(req.auth!.userId);
    return list.map(serialize);
  });

  app.get('/api/beneficiaries/recent', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 5), 20);
    const recent = await svc.listRecent(req.auth!.userId, limit);
    return recent.map(serialize);
  });

  app.get('/api/beneficiaries/search', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const query = req.query as { q?: string };
    if (!query.q) return reply.code(400).send({ error: 'query_required' });
    const results = await svc.search(req.auth!.userId, query.q);
    return results.map(serialize);
  });

  app.get('/api/beneficiaries/overview', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getBeneficiaryOverview(req.auth!.userId);
  });

  app.get('/api/beneficiaries/transfer-readiness', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTransferReadiness(req.auth!.userId);
  });

  app.get('/api/beneficiaries/currency-exposure', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCurrencyExposure(req.auth!.userId);
  });

  app.get('/api/beneficiaries/network-map', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getNetworkMap(req.auth!.userId);
    return {
      ...result,
      frequentRecipients: result.frequentRecipients.map((r: any) => ({
        ...r,
        totalVolume: r.totalVolume.toString(),
      })),
    };
  });

  app.get('/api/beneficiaries/activity-score', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getActivityScore(req.auth!.userId);
  });

  app.get('/api/beneficiaries/dormancy-report', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getDormancyReport(req.auth!.userId);
  });

  app.get('/api/beneficiaries/trust-score', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getBeneficiaryTrustScore(req.auth!.userId);
  });

  app.get('/api/beneficiaries/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = await svc.getById(id);
    if (!b || b.userId !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return serialize(b);
  });

  app.put('/api/beneficiaries/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      nickname: z.string().min(1).max(100).optional(),
      currency: z.string().length(3).optional(),
    }).parse(req.body);

    try {
      const b = await svc.update(id, req.auth!.userId, body);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'beneficiary.updated',
        payload: { beneficiaryId: id, ...body },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(b);
    } catch (err: any) {
      if (err.message === 'beneficiary_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/beneficiaries/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.remove(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'beneficiary.deleted',
        payload: { beneficiaryId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(204).send();
    } catch (err: any) {
      if (err.message === 'beneficiary_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });
}
