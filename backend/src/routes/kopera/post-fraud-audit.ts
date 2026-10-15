import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PostFraudAuditService } from '../../kopera/services/post-fraud-audit.js';

export async function registerPostFraudAuditRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new PostFraudAuditService(prisma);

  const caseSchema = z.object({
    fraudAlertId: z.string(),
    transactionId: z.string().optional(),
    reportedAmount: z.number().int().positive(),
    currency: z.string().min(3).max(3),
    description: z.string().min(1).max(2000),
  });

  const phaseSchema = z.object({
    phase: z.enum(['INVESTIGATION', 'EVIDENCE_COLLECTION', 'REVIEW', 'RECOVERY', 'CLOSED']),
  });

  const recoverySchema = z.object({
    recoveredAmount: z.number().int().positive(),
    method: z.string().min(1).max(100),
    notes: z.string().max(2000).optional(),
  });

  app.get('/api/post-fraud/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRecoveryAnalytics(req.auth!.userId);
  });

  app.get('/api/post-fraud/cases', { preHandler: [app.requireAuth] }, async (req) => {
    const cases = await svc.getAuditCases(req.auth!.userId);
    return cases.map((c: any) => ({
      ...c,
      reportedAmount: c.reportedAmount.toString(),
      totalRecovered: (c.totalRecovered || BigInt(0)).toString(),
    }));
  });

  app.post('/api/post-fraud/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = caseSchema.parse(req.body);
    try {
      const audit = await svc.createAuditCase(req.auth!.userId, {
        ...data,
        reportedAmount: BigInt(data.reportedAmount),
      });
      reply.status(201);
      return {
        ...(audit as any),
        reportedAmount: (audit as any).reportedAmount.toString(),
        totalRecovered: ((audit as any).totalRecovered || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'fraud_alert_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/post-fraud/:id/phase', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = phaseSchema.parse(req.body);
    try {
      const result = await svc.updatePhase(req.auth!.userId, id, data.phase);
      return {
        ...(result as any),
        reportedAmount: (result as any).reportedAmount.toString(),
        totalRecovered: ((result as any).totalRecovered || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'audit_case_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'audit_case_closed' || e.message === 'invalid_phase') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/post-fraud/:id/recovery', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = recoverySchema.parse(req.body);
    try {
      const recovery = await svc.recordRecovery(req.auth!.userId, id, {
        ...data,
        recoveredAmount: BigInt(data.recoveredAmount),
      });
      reply.status(201);
      return {
        ...(recovery as any),
        recoveredAmount: (recovery as any).recoveredAmount.toString(),
      };
    } catch (e: any) {
      if (e.message === 'audit_case_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'audit_case_closed') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.get('/api/post-fraud/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const audit = await svc.getAuditCase(req.auth!.userId, id);
      return {
        ...(audit as any),
        reportedAmount: (audit as any).reportedAmount.toString(),
        totalRecovered: ((audit as any).totalRecovered || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'audit_case_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      throw e;
    }
  });
}
