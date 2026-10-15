import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { FraudAlertService } from '../../kopera/services/fraud-alert.js';

export async function registerFraudAlertRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new FraudAlertService(prisma);

  const alertSchema = z.object({
    transactionId: z.string().optional(),
    alertType: z.string().min(1).max(50),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    description: z.string().min(1).max(1000),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    ipAddress: z.string().optional(),
    deviceId: z.string().optional(),
  });

  const autoBlockSchema = z.object({
    transactionId: z.string(),
    amount: z.number().int().positive(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    ipAddress: z.string().optional(),
  });

  const resolveSchema = z.object({
    resolution: z.string().min(1).max(1000),
  });

  app.get('/api/fraud-alerts/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getFraudAnalytics(req.auth!.userId);
  });

  app.get('/api/fraud-alerts/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getAlerts(req.auth!.userId);
  });

  app.post('/api/fraud-alerts/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = alertSchema.parse(req.body);
    const alert = await svc.createAlert(req.auth!.userId, data);
    reply.status(201);
    return alert;
  });

  app.post('/api/fraud-alerts/auto-block-check', { preHandler: [app.requireAuth] }, async (req) => {
    const data = autoBlockSchema.parse(req.body);
    return svc.autoBlockCheck(req.auth!.userId, data.transactionId, {
      amount: BigInt(data.amount),
      latitude: data.latitude,
      longitude: data.longitude,
      ipAddress: data.ipAddress,
    });
  });

  app.post('/api/fraud-alerts/:id/resolve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = resolveSchema.parse(req.body);
    try {
      return await svc.resolveAlert(req.auth!.userId, id, data.resolution);
    } catch (e: any) {
      if (e.message === 'alert_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'alert_already_resolved') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/fraud-alerts/:id/escalate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.escalateAlert(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'alert_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      if (e.message === 'alert_already_resolved') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.get('/api/fraud-alerts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getAlert(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'alert_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      throw e;
    }
  });
}
