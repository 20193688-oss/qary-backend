import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { BalanceAlertService } from '../../kopera/services/balance-alert.js';

export async function registerBalanceAlertRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new BalanceAlertService(prisma);

  const createSchema = z.object({
    walletId: z.string().min(1),
    alertType: z.enum(['LOW_BALANCE', 'HIGH_BALANCE', 'THRESHOLD']),
    threshold: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    currency: z.string().length(3),
    channel: z.enum(['push', 'email', 'sms']).optional(),
  });

  const toggleSchema = z.object({ active: z.boolean() });
  const thresholdSchema = z.object({
    threshold: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  });

  const serialize = (a: any) => ({ ...a, threshold: a.threshold?.toString() });

  app.get('/api/balance-alerts/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getAlertAnalytics(req.auth!.userId);
  });

  app.get('/api/balance-alerts/list', { preHandler: [app.requireAuth] }, async (req) => {
    const alerts = await svc.getAlerts(req.auth!.userId);
    return (alerts as any[]).map(serialize);
  });

  app.post('/api/balance-alerts/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const alert = await svc.createAlert(req.auth!.userId, data);
    reply.status(201);
    return serialize(alert);
  });

  app.post('/api/balance-alerts/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = toggleSchema.parse(req.body);
    try {
      const alert = await svc.toggleAlert(req.auth!.userId, id, data.active);
      return serialize(alert);
    } catch (e: any) {
      if (e.message === 'alert_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/balance-alerts/:id/threshold', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = thresholdSchema.parse(req.body);
    try {
      const alert = await svc.updateThreshold(req.auth!.userId, id, data.threshold);
      return serialize(alert);
    } catch (e: any) {
      if (e.message === 'alert_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/balance-alerts/:id/trigger', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const alert = await svc.recordTrigger(req.auth!.userId, id);
      return serialize(alert);
    } catch (e: any) {
      if (e.message === 'alert_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/balance-alerts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const alert = await svc.deleteAlert(req.auth!.userId, id);
      return serialize(alert);
    } catch (e: any) {
      if (e.message === 'alert_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/balance-alerts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const alert = await svc.getAlert(req.auth!.userId, id);
      return serialize(alert);
    } catch (e: any) {
      if (e.message === 'alert_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
