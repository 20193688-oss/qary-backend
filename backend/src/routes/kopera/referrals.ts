import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ReferralService } from '../../kopera/services/referrals.js';
import { audit } from '../../lib/audit.js';

function serialize(r: any) {
  return {
    code: r.code,
    status: r.status,
    signupCount: r.signupCount,
    rewardedCount: r.rewardedCount,
    totalPointsEarned: r.totalPointsEarned,
    createdAt: r.createdAt,
  };
}

export async function registerReferralRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ReferralService(prisma);

  app.get('/api/referrals/all', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; status?: string };
    const list = await svc.listAll({
      status: query.status,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return list.map((r: any) => ({
      id: r.id,
      referrerId: r.referrerId,
      code: r.code,
      status: r.status,
      signupCount: r.signupCount,
      rewardedCount: r.rewardedCount,
      totalPointsEarned: r.totalPointsEarned,
      createdAt: r.createdAt,
    }));
  });

  app.get('/api/referrals/my-code', { preHandler: [app.requireAuth] }, async (req) => {
    const code = await svc.getOrCreateCode(req.auth!.userId);
    return { code };
  });

  app.get('/api/referrals/stats', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const referral = await svc.getByUser(req.auth!.userId);
    if (!referral) return reply.code(200).send({ code: null, signupCount: 0, rewardedCount: 0, totalPointsEarned: 0 });
    return serialize(referral);
  });

  app.get('/api/referrals/signups', { preHandler: [app.requireAuth] }, async (req) => {
    const signups = await svc.listSignups(req.auth!.userId);
    return signups.map((s: any) => ({
      id: s.id,
      referredUserId: s.referredUserId,
      status: s.status,
      rewardedAt: s.rewardedAt,
      createdAt: s.createdAt,
    }));
  });

  app.get('/api/referrals/validate/:code', async (req) => {
    const { code } = req.params as { code: string };
    return svc.validateCode(code);
  });

  app.post('/api/referrals/deactivate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const referral = await svc.deactivate(req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'referral.deactivated',
        payload: { code: referral.code },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(referral);
    } catch (err: any) {
      if (err.message === 'referral_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'already_inactive') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/referrals/activate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const referral = await svc.activate(req.auth!.userId);
      return serialize(referral);
    } catch (err: any) {
      if (err.message === 'referral_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'already_active') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/referrals/apply', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      code: z.string().min(1),
    }).parse(req.body);

    try {
      const referral = await svc.recordSignup(body.code, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'referral.applied',
        payload: { code: body.code, referrerId: referral.referrerId },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(200).send({ applied: true, referrerId: referral.referrerId });
    } catch (err: any) {
      if (err.message === 'invalid_referral_code') return reply.code(404).send({ error: err.message });
      if (err.message === 'referral_inactive') return reply.code(400).send({ error: err.message });
      if (err.message === 'cannot_refer_self') return reply.code(400).send({ error: err.message });
      if (err.message === 'already_referred') return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/referrals/reward', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const result = await svc.rewardReferrer(req.auth!.userId);
    if (!result) return reply.code(200).send({ rewarded: false });

    await audit(prisma, {
      userId: result.referrerId, actor: 'system', eventType: 'referral.rewarded',
      payload: { referredUserId: req.auth!.userId, pointsAwarded: result.pointsAwarded },
      requestId: String(req.id), ip: req.ip,
    });
    return reply.code(200).send({ rewarded: true, pointsAwarded: result.pointsAwarded });
  });
}
