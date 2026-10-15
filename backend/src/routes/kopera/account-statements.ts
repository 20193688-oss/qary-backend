import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AccountStatementService } from '../../kopera/services/account-statement.js';

export async function registerAccountStatementRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new AccountStatementService(prisma);

  const generateSchema = z.object({
    walletId: z.string(),
    periodStart: z.string().transform((s) => new Date(s)),
    periodEnd: z.string().transform((s) => new Date(s)),
    format: z.enum(['JSON', 'CSV', 'PDF']).optional(),
  });

  app.get('/api/account-statements/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getStatementAnalytics(req.auth!.userId);
  });

  app.get('/api/account-statements/list', { preHandler: [app.requireAuth] }, async (req) => {
    const statements = await svc.getStatements(req.auth!.userId);
    return (statements as any[]).map((s) => ({
      ...s,
      openingBalance: ((s.openingBalance as bigint) || BigInt(0)).toString(),
      closingBalance: ((s.closingBalance as bigint) || BigInt(0)).toString(),
      totalCredits: ((s.totalCredits as bigint) || BigInt(0)).toString(),
      totalDebits: ((s.totalDebits as bigint) || BigInt(0)).toString(),
    }));
  });

  app.post('/api/account-statements/generate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = generateSchema.parse(req.body);
    try {
      const statement = await svc.generateStatement(req.auth!.userId, data);
      reply.status(201);
      return {
        ...(statement as any),
        openingBalance: ((statement as any).openingBalance || BigInt(0)).toString(),
        closingBalance: ((statement as any).closingBalance || BigInt(0)).toString(),
        totalCredits: ((statement as any).totalCredits || BigInt(0)).toString(),
        totalDebits: ((statement as any).totalDebits || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'wallet_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-statements/:id/download', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const statement = await svc.downloadStatement(req.auth!.userId, id);
      return {
        ...(statement as any),
        openingBalance: ((statement as any).openingBalance || BigInt(0)).toString(),
        closingBalance: ((statement as any).closingBalance || BigInt(0)).toString(),
        totalCredits: ((statement as any).totalCredits || BigInt(0)).toString(),
        totalDebits: ((statement as any).totalDebits || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'statement_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/account-statements/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const statement = await svc.getStatement(req.auth!.userId, id);
      return {
        ...(statement as any),
        openingBalance: ((statement as any).openingBalance || BigInt(0)).toString(),
        closingBalance: ((statement as any).closingBalance || BigInt(0)).toString(),
        totalCredits: ((statement as any).totalCredits || BigInt(0)).toString(),
        totalDebits: ((statement as any).totalDebits || BigInt(0)).toString(),
      };
    } catch (e: any) {
      if (e.message === 'statement_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
