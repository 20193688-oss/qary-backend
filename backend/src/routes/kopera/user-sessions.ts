import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { UserSessionService } from '../../kopera/services/user-sessions.js';

function serialize(s: any) {
  return {
    id: s.id,
    userId: s.userId,
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    ip: s.ip,
    userAgent: s.userAgent,
    lastActiveAt: s.lastActiveAt,
    expiresAt: s.expiresAt,
    revokedAt: s.revokedAt,
    createdAt: s.createdAt,
  };
}

export async function registerUserSessionRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new UserSessionService(prisma);

  app.post('/api/sessions', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      deviceId: z.string().min(1),
      deviceName: z.string().optional(),
      ip: z.string().min(1),
      userAgent: z.string().optional(),
      expiresAt: z.string().datetime(),
    }).parse(req.body);

    const session = await svc.createSession(req.auth!.userId, {
      ...body,
      expiresAt: new Date(body.expiresAt),
    });
    return reply.code(201).send(serialize(session));
  });

  app.get('/api/sessions', { preHandler: [app.requireAuth] }, async (req) => {
    const sessions = await svc.listActive(req.auth!.userId);
    return sessions.map(serialize);
  });

  app.get('/api/sessions/history', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string };
    const sessions = await svc.listAll(req.auth!.userId, {
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return sessions.map(serialize);
  });

  app.get('/api/sessions/security-overview', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSecurityOverview(req.auth!.userId);
  });

  app.get('/api/sessions/device-report', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getDeviceReport(req.auth!.userId);
  });

  app.get('/api/sessions/geo-distribution', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getGeoDistribution(req.auth!.userId);
  });

  app.get('/api/sessions/lifecycle', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSessionLifecycle(req.auth!.userId);
  });

  app.get('/api/sessions/risk-assessment', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRiskAssessment(req.auth!.userId);
  });

  app.get('/api/sessions/login-frequency', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getLoginFrequency(req.auth!.userId);
  });

  app.get('/api/sessions/anomaly-detection', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSessionAnomalyDetection(req.auth!.userId);
  });

  app.get('/api/sessions/device-fingerprinting', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSessionDeviceFingerprinting(req.auth!.userId);
  });

  app.get('/api/sessions/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await svc.getSession(id, req.auth!.userId);
    if (!session) return reply.code(404).send({ error: 'not_found' });
    return serialize(session);
  });

  app.post('/api/sessions/:id/revoke', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const session = await svc.revoke(id, req.auth!.userId);
      return serialize(session);
    } catch (e: any) {
      if (e.message === 'session_not_found') return reply.code(404).send({ error: e.message });
      if (e.message === 'forbidden') return reply.code(403).send({ error: e.message });
      if (e.message === 'already_revoked') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/sessions/:id/touch', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await svc.getSession(id, req.auth!.userId);
    if (!session) return reply.code(404).send({ error: 'not_found' });

    const updated = await svc.touch(id);
    return serialize(updated);
  });

  app.post('/api/sessions/cleanup-expired', { preHandler: [app.requireAuth] }, async () => {
    return svc.cleanupExpired();
  });

  app.post('/api/sessions/revoke-others', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      currentSessionId: z.string().min(1),
    }).parse(req.body);

    const result = await svc.revokeAllOther(req.auth!.userId, body.currentSessionId);
    return { revoked: result.count };
  });
}
