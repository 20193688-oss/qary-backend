import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ComplianceReportService } from '../../kopera/services/compliance-report.js';

export async function registerComplianceReportRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ComplianceReportService(prisma);

  const generateSchema = z.object({
    reportType: z.enum(['AML', 'TRANSACTION_MONITORING', 'RISK_ASSESSMENT', 'PERIODIC']),
    periodStart: z.string().transform((s) => new Date(s)),
    periodEnd: z.string().transform((s) => new Date(s)),
    currency: z.string().min(3).max(3).optional(),
  });

  const flagSchema = z.object({
    notes: z.string().min(1).max(2000),
  });

  app.get('/api/compliance-reports/summary', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getComplianceSummary(req.auth!.userId);
  });

  app.get('/api/compliance-reports/list', { preHandler: [app.requireAuth] }, async (req) => {
    const reports = await svc.getReports(req.auth!.userId);
    return (reports as any[]).map((r) => ({
      ...r,
      totalVolume: ((r.totalVolume as bigint) || BigInt(0)).toString(),
    }));
  });

  app.post('/api/compliance-reports/generate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = generateSchema.parse(req.body);
    const report = await svc.generateReport(req.auth!.userId, data);
    reply.status(201);
    return {
      ...(report as any),
      totalVolume: ((report as any).totalVolume || BigInt(0)).toString(),
    };
  });

  app.post('/api/compliance-reports/:id/flag', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = flagSchema.parse(req.body);
    try {
      const result = await svc.flagReport(req.auth!.userId, id, data.notes);
      return {
        ...(result as any),
        totalVolume: ((result as any).totalVolume || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'report_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'report_archived') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/compliance-reports/:id/archive', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await svc.archiveReport(req.auth!.userId, id);
      return {
        ...(result as any),
        totalVolume: ((result as any).totalVolume || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'report_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'report_already_archived') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/compliance-reports/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const report = await svc.getReport(req.auth!.userId, id);
      return {
        ...(report as any),
        totalVolume: ((report as any).totalVolume || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'report_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
