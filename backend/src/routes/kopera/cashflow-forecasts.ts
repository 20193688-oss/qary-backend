import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { CashflowForecastService } from '../../kopera/services/cashflow-forecast.js';

export async function registerCashflowForecastRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new CashflowForecastService(prisma);

  const createSchema = z.object({
    period: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    projectedInflow: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    projectedOutflow: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    notes: z.string().optional(),
  });

  const serialize = (f: any) => ({
    ...f,
    projectedInflow: f.projectedInflow?.toString(),
    projectedOutflow: f.projectedOutflow?.toString(),
    netFlow: f.netFlow?.toString(),
  });

  app.get('/api/cashflow-forecasts/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getForecastAnalytics(req.auth!.userId);
  });

  app.get('/api/cashflow-forecasts/list', { preHandler: [app.requireAuth] }, async (req) => {
    const forecasts = await svc.getForecasts(req.auth!.userId);
    return (forecasts as any[]).map(serialize);
  });

  app.post('/api/cashflow-forecasts/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const fc = await svc.createForecast(req.auth!.userId, data);
    reply.status(201);
    return serialize(fc);
  });

  app.post('/api/cashflow-forecasts/:id/finalize', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const fc = await svc.finalizeForecast(req.auth!.userId, id);
      return serialize(fc);
    } catch (e: any) {
      if (e.message === 'forecast_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'forecast_not_draft') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/cashflow-forecasts/:id/archive', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const fc = await svc.archiveForecast(req.auth!.userId, id);
      return serialize(fc);
    } catch (e: any) {
      if (e.message === 'forecast_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'forecast_already_archived') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/cashflow-forecasts/period/:period', { preHandler: [app.requireAuth] }, async (req) => {
    const { period } = req.params as { period: string };
    const forecasts = await svc.getByPeriod(req.auth!.userId, period);
    return (forecasts as any[]).map(serialize);
  });

  app.delete('/api/cashflow-forecasts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const fc = await svc.deleteForecast(req.auth!.userId, id);
      return serialize(fc);
    } catch (e: any) {
      if (e.message === 'forecast_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/cashflow-forecasts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const fc = await svc.getForecast(req.auth!.userId, id);
      return serialize(fc);
    } catch (e: any) {
      if (e.message === 'forecast_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
