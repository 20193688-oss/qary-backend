import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { NotificationService } from '../../kopera/services/notifications.js';

export async function registerNotificationRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const notifications = new NotificationService(prisma);

  app.get('/api/notifications', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; unreadOnly?: string };
    const list = await notifications.listByUser(req.auth!.userId, {
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
      unreadOnly: query.unreadOnly === 'true',
    });
    return list.map(serializeNotification);
  });

  app.get('/api/notifications/unread-count', { preHandler: [app.requireAuth] }, async (req) => {
    const count = await notifications.unreadCount(req.auth!.userId);
    return { count };
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
    createdAt: n.createdAt,
  };
}
