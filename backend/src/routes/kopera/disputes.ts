import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { DisputeService } from '../../kopera/services/disputes.js';
import { audit } from '../../lib/audit.js';

export async function registerDisputeRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const disputes = new DisputeService(prisma);

  app.post('/api/disputes', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      gatewayPaymentId: z.string().min(1),
      reason: z.string().min(1),
      amount: z.number().positive(),
      currency: z.string().length(3),
    }).parse(req.body);

    try {
      const dispute = await disputes.create({
        userId: req.auth!.userId,
        gatewayPaymentId: body.gatewayPaymentId,
        reason: body.reason,
        amount: BigInt(Math.round(body.amount * 100)),
        currency: body.currency,
      });

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'dispute.created',
        payload: { disputeId: dispute.id, gatewayPaymentId: body.gatewayPaymentId },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.code(201).send(serializeDispute(dispute));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'payment_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'dispute_already_exists') return reply.code(409).send({ error: msg });
      throw err;
    }
  });

  app.get('/api/disputes', { preHandler: [app.requireAuth] }, async (req) => {
    const list = await disputes.listByUser(req.auth!.userId);
    return list.map(serializeDispute);
  });

  app.get('/api/disputes/stats', { preHandler: [app.requireAuth] }, async (req) => {
    const stats = await disputes.getStats(req.auth!.userId);
    return {
      totalDisputes: stats.totalDisputes,
      totalAmount: stats.totalAmount.toString(),
      byStatus: stats.byStatus,
      avgResolutionDays: stats.avgResolutionDays,
    };
  });

  app.get('/api/disputes/expiring-evidence', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { days?: string };
    const withinDays = Math.min(Number(query.days ?? 7), 90);
    const results = await disputes.getExpiringEvidence(req.auth!.userId, withinDays);
    return results.map((d: any) => ({
      ...d,
      amount: d.amount.toString(),
    }));
  });

  app.get('/api/disputes/resolution-report', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getResolutionReport(req.auth!.userId);
  });

  app.get('/api/disputes/escalation-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getEscalationAnalysis(req.auth!.userId);
  });

  app.get('/api/disputes/financial-impact', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getFinancialImpact(req.auth!.userId);
  });

  app.get('/api/disputes/risk-assessment', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await disputes.getRiskAssessment(req.auth!.userId);
    return {
      ...result,
      totalAmount: result.totalAmount.toString(),
    };
  });

  app.get('/api/disputes/all', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; status?: string };
    const list = await disputes.listAll({
      status: query.status,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return list.map(serializeDispute);
  });

  app.get('/api/disputes/outcome-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getOutcomeAnalysis(req.auth!.userId);
  });

  app.get('/api/disputes/response-time-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getResponseTimeAnalysis(req.auth!.userId);
  });

  app.get('/api/disputes/outcome-predictor', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getDisputeOutcomePredictor(req.auth!.userId);
  });

  app.get('/api/disputes/aging-report', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getDisputeAgingReport(req.auth!.userId);
  });

  app.get('/api/disputes/resolution-efficiency', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getDisputeResolutionEfficiency(req.auth!.userId);
  });

  app.get('/api/disputes/escalation-effectiveness', { preHandler: [app.requireAuth] }, async (req) => {
    return disputes.getDisputeEscalationEffectiveness(req.auth!.userId);
  });

  app.get('/api/disputes/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dispute = await disputes.getById(id);
    if (!dispute) return reply.code(404).send({ error: 'not_found' });
    if (dispute.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return serializeDispute(dispute);
  });

  app.post('/api/disputes/:id/evidence', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      evidence: z.record(z.unknown()),
    }).parse(req.body);

    try {
      const dispute = await disputes.submitEvidence(id, req.auth!.userId, body.evidence);
      return reply.send(serializeDispute(dispute));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'dispute_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'dispute_not_open') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/disputes/:id/escalate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const dispute = await disputes.escalate(id, req.auth!.userId);
      return reply.send(serializeDispute(dispute));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'dispute_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'dispute_not_open') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/disputes/:id/resolve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      outcome: z.enum(['WON', 'LOST', 'ACCEPTED']),
      notes: z.string().optional(),
    }).parse(req.body);

    try {
      const dispute = await disputes.resolve(id, body.outcome, body.notes);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'dispute.resolved',
        payload: { disputeId: id, outcome: body.outcome },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.send(serializeDispute(dispute));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'dispute_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'dispute_already_resolved') return reply.code(400).send({ error: msg });
      throw err;
    }
  });
}

function serializeDispute(d: any) {
  return {
    id: d.id,
    gatewayPaymentId: d.gatewayPaymentId,
    status: d.status,
    reason: d.reason,
    amount: d.amount.toString(),
    currency: d.currency,
    evidenceSubmitted: d.evidenceSubmitted,
    evidenceDeadline: d.evidenceDeadline,
    resolvedAt: d.resolvedAt,
    outcome: d.outcome,
    createdAt: d.createdAt,
  };
}
