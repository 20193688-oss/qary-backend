import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionExportService } from '../../kopera/services/transaction-export.js';

export async function registerTransactionExportRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionExportService(prisma);

  const createSchema = z.object({
    format: z.string().min(1),
    dateFrom: z.string().transform((v) => new Date(v)),
    dateTo: z.string().transform((v) => new Date(v)),
    currency: z.string().length(3).optional(),
  });

  const serialize = (e: any) => ({ ...e });

  app.get('/api/transaction-exports/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getExportAnalytics(req.auth!.userId);
  });

  app.get('/api/transaction-exports/list', { preHandler: [app.requireAuth] }, async (req) => {
    const exports = await svc.getExports(req.auth!.userId);
    return (exports as any[]).map(serialize);
  });

  app.post('/api/transaction-exports/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const e = await svc.createExport(req.auth!.userId, data);
    reply.status(201);
    return serialize(e);
  });

  app.post('/api/transaction-exports/:id/process', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { recordCount, fileSize } = z.object({
      recordCount: z.number().int().min(0),
      fileSize: z.number().int().min(0),
    }).parse(req.body);
    try {
      const e = await svc.processExport(req.auth!.userId, id, recordCount, fileSize);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'export_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'export_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-exports/:id/download', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const e = await svc.downloadExport(req.auth!.userId, id);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'export_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'export_not_completed') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/transaction-exports/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const e = await svc.cancelExport(req.auth!.userId, id);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'export_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'export_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/transaction-exports/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const e = await svc.getExport(req.auth!.userId, id);
      return serialize(e);
    } catch (e: any) {
      if (e.message === 'export_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
