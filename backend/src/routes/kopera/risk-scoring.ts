import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { RiskScoringService } from '../../kopera/services/risk-scoring.js';

export async function registerRiskScoringRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new RiskScoringService(prisma);

  const createSchema = z.object({
    entityType: z.string().min(1).max(100),
    entityId: z.string().min(1),
    riskScore: z.number().int().min(0).max(100),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    factors: z.array(z.string()).min(1),
    notes: z.string().max(1000).optional(),
  });

  const updateSchema = z.object({
    riskScore: z.number().int().min(0).max(100),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    factors: z.array(z.string()).optional(),
    notes: z.string().max(1000).optional(),
  });

  app.get('/api/risk-scoring/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRiskAnalytics(req.auth!.userId);
  });

  app.get('/api/risk-scoring/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getAssessments(req.auth!.userId);
  });

  app.post('/api/risk-scoring/assess', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const assessment = await svc.createAssessment(req.auth!.userId, data);
      reply.status(201);
      return assessment;
    } catch (e: any) {
      if (e.message === 'invalid_risk_score') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/risk-scoring/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      return await svc.updateScore(req.auth!.userId, id, data);
    } catch (e: any) {
      if (e.message === 'assessment_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'invalid_risk_score') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/risk-scoring/:id/archive', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.archiveAssessment(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'assessment_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'assessment_already_archived') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/risk-scoring/entity/:entityType/:entityId', { preHandler: [app.requireAuth] }, async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    return svc.getByEntity(req.auth!.userId, entityType, entityId);
  });

  app.get('/api/risk-scoring/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getAssessment(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'assessment_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
