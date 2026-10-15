import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { SettlementReportService } from '../../kopera/services/settlement-report.js';

export async function registerSettlementReportRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new SettlementReportService(prisma);

  const createSchema = z.object({
    periodStart: z.string().transform((v) => new Date(v)),
    periodEnd: z.string().transform((v) => new Date(v)),
    currency: z.string().length(3),
    totalSettled: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    transactionCount: z.number().int().min(0),
  });

  const serialize = (r: any) => ({
    ...r,
    totalSettled: r.totalSettled?.toString(),
    totalFees: r.totalFees?.toString(),
    netAmount: r.netAmount?.toString(),
  });

  app.get('/api/settlement-reports/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getReportAnalytics(req.auth!.userId);
  });

  app.get('/api/settlement-reports/list', { preHandler: [app.requireAuth] }, async (req) => {
    const reports = await svc.getReports(req.auth!.userId);
    return (reports as any[]).map(serialize);
  });

  app.post('/api/settlement-reports/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const r = await svc.createReport(req.auth!.userId, data);
    reply.status(201);
    return serialize(r);
  });

  app.post('/api/settlement-reports/:id/finalize', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.finalizeReport(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'report_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'report_not_generated') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/settlement-reports/:id/archive', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.archiveReport(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'report_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'report_not_finalized') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/settlement-reports/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await svc.getReport(req.auth!.userId, id);
      return serialize(r);
    } catch (e: any) {
      if (e.message === 'report_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
