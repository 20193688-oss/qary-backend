import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { NotificationService } from '../../kopera/services/notifications.js';
import { audit } from '../../lib/audit.js';

export async function registerNotificationRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const notifications = new NotificationService(prisma);

  app.post('/api/notifications/send', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      userId: z.string().min(1),
      type: z.string().min(1),
      channel: z.enum(['EMAIL', 'SMS', 'PUSH', 'WHATSAPP', 'IN_APP']).default('IN_APP'),
      subject: z.string().optional(),
      body: z.string().min(1),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const n = await notifications.create({
      userId: body.userId,
      type: body.type,
      channel: body.channel,
      subject: body.subject,
      body: body.body,
      metadata: body.metadata,
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'system', eventType: 'notification.sent',
      payload: { notificationId: n.id, channel: body.channel, targetUserId: body.userId },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send(serializeNotification(n));
  });

  app.get('/api/notifications', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; unreadOnly?: string; type?: string; channel?: string };
    const list = await notifications.listByUser(req.auth!.userId, {
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
      unreadOnly: query.unreadOnly === 'true',
      type: query.type,
      channel: query.channel,
    });
    return list.map(serializeNotification);
  });

  app.get('/api/notifications/stats', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getStats(req.auth!.userId);
  });

  app.get('/api/notifications/unread-count', { preHandler: [app.requireAuth] }, async (req) => {
    const count = await notifications.unreadCount(req.auth!.userId);
    return { count };
  });

  app.get('/api/notifications/delivery-report', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getDeliveryReport(req.auth!.userId);
  });

  app.get('/api/notifications/engagement-report', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getEngagementReport(req.auth!.userId);
  });

  app.get('/api/notifications/channel-effectiveness', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getChannelEffectiveness(req.auth!.userId);
  });

  app.get('/api/notifications/fatigue', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getNotificationFatigue(req.auth!.userId);
  });

  app.get('/api/notifications/type-effectiveness', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getTypeEffectiveness(req.auth!.userId);
  });

  app.get('/api/notifications/delivery-latency', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getDeliveryLatencyReport(req.auth!.userId);
  });

  app.get('/api/notifications/engagement-analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return notifications.getNotificationEngagementReport(req.auth!.userId);
  });

  app.get('/api/notifications/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = await notifications.getById(id);
    if (!n) return reply.code(404).send({ error: 'not_found' });
    if (n.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return serializeNotification(n);
  });

  app.post('/api/notifications/:id/read', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const n = await notifications.markAsRead(req.auth!.userId, id);
      return reply.send(serializeNotification(n));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'notification_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/notifications/read-all', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await notifications.markAllAsRead(req.auth!.userId);
    return { updated: result.count };
  });

  app.post('/api/notifications/:id/delivered', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const n = await notifications.markDelivered(id);
      return reply.send(serializeNotification(n));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'notification_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'already_delivered') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/notifications/:id/failed', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      reason: z.string().min(1),
    }).parse(req.body);

    try {
      const n = await notifications.markFailed(id, body.reason);
      return reply.send(serializeNotification(n));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'notification_not_found') return reply.code(404).send({ error: msg });
      throw err;
    }
  });

  app.delete('/api/notifications/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await notifications.delete(id, req.auth!.userId);
      return reply.send({ deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'notification_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      throw err;
    }
  });
}

function serializeNotification(n: any) {
  return {
    id: n.id,
    type: n.type,
    channel: n.channel,
    subject: n.subject,
    body: n.body,
    metadata: n.metadata,
    readAt: n.readAt,
    deliveredAt: n.deliveredAt ?? null,
    failedAt: n.failedAt ?? null,
    failReason: n.failReason ?? null,
    createdAt: n.createdAt,
  };
}
