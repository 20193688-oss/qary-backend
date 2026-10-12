import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { UserProfileService } from '../../kopera/services/user-profiles.js';
import { EventService } from '../../kopera/services/events.js';
import { audit } from '../../lib/audit.js';

function serialize(u: any) {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    name: u.name,
    role: u.role,
    accountType: u.accountType,
    mfaEnabled: u.mfaEnabled,
    emailVerified: u.emailVerified,
    phoneVerified: u.phoneVerified,
    locale: u.locale,
    timezone: u.timezone,
    country: u.country,
    preferredCurrency: u.preferredCurrency,
    createdAt: u.createdAt,
  };
}

export async function registerUserProfileRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new UserProfileService(prisma);
  const eventSvc = new EventService(prisma);

  app.get('/api/profile', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const user = await svc.getProfile(req.auth!.userId);
    if (!user) return reply.code(404).send({ error: 'not_found' });
    return serialize(user);
  });

  app.patch('/api/profile', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      locale: z.string().min(2).optional(),
      timezone: z.string().min(1).optional(),
      country: z.string().length(2).optional(),
      preferredCurrency: z.string().length(3).optional(),
    }).parse(req.body);

    try {
      const user = await svc.updateProfile(req.auth!.userId, body);
      return serialize(user);
    } catch (e: any) {
      if (e.message === 'user_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/profile/account-overview', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getAccountOverview(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'user_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/profile/health-report', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const result = await svc.getAccountHealthReport(req.auth!.userId);
      return {
        ...result,
        totalBalance: result.totalBalance.toString(),
      };
    } catch (e: any) {
      if (e.message === 'user_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/profile/security-activity', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const events = await eventSvc.list({ userId: req.auth!.userId, limit: 200 });
    const securityEvents = events
      .filter((e: any) => e.eventType.startsWith('profile.') || e.eventType === 'auth.login' || e.eventType === 'auth.verify')
      .slice(0, limit)
      .map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        ip: e.ip,
        createdAt: e.createdAt,
      }));
    return securityEvents;
  });

  app.post('/api/profile/mfa/enable', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      secret: z.string().min(1),
    }).parse(req.body);

    try {
      const user = await svc.enableMfa(req.auth!.userId, body.secret);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'profile.mfa_enabled',
        payload: {}, requestId: String(req.id), ip: req.ip,
      });
      return serialize(user);
    } catch (e: any) {
      if (e.message === 'mfa_already_enabled') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/profile/mfa/disable', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const user = await svc.disableMfa(req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'profile.mfa_disabled',
        payload: {}, requestId: String(req.id), ip: req.ip,
      });
      return serialize(user);
    } catch (e: any) {
      if (e.message === 'mfa_not_enabled') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/profile/pin', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      pin: z.string().length(6),
    }).parse(req.body);

    await svc.setPin(req.auth!.userId, body.pin);
    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'profile.pin_set',
      payload: {}, requestId: String(req.id), ip: req.ip,
    });
    return { success: true };
  });

  app.post('/api/profile/deactivate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      await svc.deactivateAccount(req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'profile.deactivated',
        payload: {}, requestId: String(req.id), ip: req.ip,
      });
      return { success: true };
    } catch (e: any) {
      if (e.message === 'user_not_found') return reply.code(404).send({ error: e.message });
      if (e.message === 'already_deactivated') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/profile/upgrade-business', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const user = await svc.upgradeToBusinessAccount(req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'profile.upgraded_to_business',
        payload: {}, requestId: String(req.id), ip: req.ip,
      });
      return serialize(user);
    } catch (e: any) {
      if (e.message === 'already_business') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
}
