import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { NotificationPrefsService } from '../../kopera/services/notification-prefs.js';

export async function registerNotificationPrefRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new NotificationPrefsService(prisma);

  const setSchema = z.object({
    eventType: z.string().min(1).max(100),
    channel: z.enum(['push', 'email', 'sms', 'in_app']),
    enabled: z.boolean(),
  });

  const bulkSchema = z.object({
    preferences: z.array(setSchema).min(1).max(50),
  });

  app.get('/api/notification-prefs/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPreferenceAnalytics(req.auth!.userId);
  });

  app.get('/api/notification-prefs/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPreferences(req.auth!.userId);
  });

  app.post('/api/notification-prefs/set', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = setSchema.parse(req.body);
    const pref = await svc.setPreference(req.auth!.userId, data);
    reply.status(201);
    return pref;
  });

  app.post('/api/notification-prefs/bulk', { preHandler: [app.requireAuth] }, async (req) => {
    const data = bulkSchema.parse(req.body);
    return svc.bulkSet(req.auth!.userId, data.preferences);
  });

  app.post('/api/notification-prefs/reset', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.resetToDefaults(req.auth!.userId);
  });

  app.get('/api/notification-prefs/event/:eventType', { preHandler: [app.requireAuth] }, async (req) => {
    const { eventType } = req.params as { eventType: string };
    return svc.getPreferencesByEvent(req.auth!.userId, eventType);
  });
}
