import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AccountVerificationService } from '../../kopera/services/account-verification.js';

export async function registerAccountVerificationRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new AccountVerificationService(prisma);

  const initiateSchema = z.object({
    verificationType: z.enum(['EMAIL', 'PHONE', 'IDENTITY', 'ADDRESS']),
    method: z.enum(['OTP', 'LINK', 'DOCUMENT']),
    target: z.string().min(1),
  });

  const confirmSchema = z.object({ code: z.string().length(6) });

  app.get('/api/account-verifications/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getVerificationAnalytics(req.auth!.userId);
  });

  app.get('/api/account-verifications/list', { preHandler: [app.requireAuth] }, async (req) => {
    const vers = await svc.getVerifications(req.auth!.userId);
    return vers;
  });

  app.post('/api/account-verifications/initiate', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = initiateSchema.parse(req.body);
    const v = await svc.initiateVerification(req.auth!.userId, data);
    reply.status(201);
    return v;
  });

  app.post('/api/account-verifications/:id/confirm', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = confirmSchema.parse(req.body);
    try {
      const v = await svc.confirmVerification(req.auth!.userId, id, data.code);
      return v;
    } catch (e: any) {
      if (e.message === 'verification_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'verification_not_pending') { reply.status(400); return { error: e.message }; }
      if (e.message === 'max_attempts_exceeded') { reply.status(400); return { error: e.message }; }
      if (e.message === 'invalid_verification_code') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-verifications/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const v = await svc.cancelVerification(req.auth!.userId, id);
      return v;
    } catch (e: any) {
      if (e.message === 'verification_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'verification_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-verifications/:id/resend', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const v = await svc.resendCode(req.auth!.userId, id);
      return v;
    } catch (e: any) {
      if (e.message === 'verification_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'verification_not_pending') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/account-verifications/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const v = await svc.getVerification(req.auth!.userId, id);
      return v;
    } catch (e: any) {
      if (e.message === 'verification_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
