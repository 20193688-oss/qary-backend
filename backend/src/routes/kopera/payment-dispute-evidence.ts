import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentDisputeEvidenceService } from '../../kopera/services/payment-dispute-evidence.js';

export async function registerPaymentDisputeEvidenceRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PaymentDisputeEvidenceService(prisma);

  const createSchema = z.object({
    disputeId: z.string().min(1),
    evidenceType: z.string().min(1),
    description: z.string().min(1),
    fileUrl: z.string().optional(),
  });

  const serialize = (e: any) => ({ ...e });

  app.get('/api/payment-dispute-evidence/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getEvidenceAnalytics(req.auth!.userId);
  });

  app.get('/api/payment-dispute-evidence/list', { preHandler: [app.requireAuth] }, async (req) => {
    const items = await svc.getEvidenceList(req.auth!.userId);
    return (items as any[]).map(serialize);
  });

  app.post('/api/payment-dispute-evidence/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const e = await svc.createEvidence(req.auth!.userId, data);
    reply.status(201);
    return serialize(e);
  });

  app.post('/api/payment-dispute-evidence/:id/review', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const e = await svc.reviewEvidence(req.auth!.userId, id);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'evidence_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'evidence_not_submitted') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-dispute-evidence/:id/accept', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const e = await svc.acceptEvidence(req.auth!.userId, id);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'evidence_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'evidence_not_under_review') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/payment-dispute-evidence/:id/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    try {
      const e = await svc.rejectEvidence(req.auth!.userId, id, reason);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'evidence_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'evidence_not_under_review') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/payment-dispute-evidence/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const e = await svc.getEvidence(req.auth!.userId, id);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'evidence_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
