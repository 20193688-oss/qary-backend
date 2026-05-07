import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { hashSecret, verifySecret } from '../lib/password.js';
import { createOtpStore, generateOtp } from '../lib/otp.js';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../lib/jwt.js';
import { audit } from '../lib/audit.js';

interface Deps {
  prisma: PrismaClient;
  redis: Redis;
}

const RegisterBody = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(8).max(200).optional(),
});

const VerifyOtpBody = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{4}$/),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RefreshBody = z.object({ refreshToken: z.string().min(10) });
const LogoutBody = z.object({ refreshToken: z.string().min(10) });

const SetPinBody = z.object({ pin: z.string().regex(/^\d{4}$/) });

export async function registerAuthRoutes(app: FastifyInstance, deps: Deps) {
  const { prisma, redis } = deps;
  const otp = createOtpStore(redis);

  app.post('/api/auth/register', async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const email = body.email.toLowerCase();
    const passwordHash = body.password ? await hashSecret(body.password) : null;
    const user = await prisma.user.upsert({
      where: { email },
      update: { name: body.name ?? undefined, ...(passwordHash ? { passwordHash } : {}) },
      create: { email, name: body.name, passwordHash },
    });
    const code = generateOtp();
    await otp.setOtp(email, code);
    await audit(prisma, {
      userId: user.id, actor: 'user', eventType: 'auth.register',
      payload: { email }, requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'],
    });

    // El OTP solo se devuelve cuando NODE_ENV !== 'production'. En prod va por SendGrid (PR siguiente).
    const debug = process.env.NODE_ENV === 'production' ? undefined : code;
    return reply.send({ ok: true, userId: user.id, debugOtp: debug });
  });

  app.post('/api/auth/verify-otp', async (req, reply) => {
    const body = VerifyOtpBody.parse(req.body);
    const email = body.email.toLowerCase();
    const result = await otp.verifyOtp(email, body.code);
    if (!result.ok) {
      await audit(prisma, {
        actor: 'user', eventType: 'auth.otp_failed',
        payload: { email, reason: result.reason }, requestId: req.id, ip: req.ip,
      });
      return reply.code(400).send({ error: result.reason });
    }
    const user = await prisma.user.update({
      where: { email }, data: { emailVerified: true },
    });
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    const { raw: refreshToken } = await issueRefreshToken(prisma, {
      userId: user.id, userAgent: req.headers['user-agent'], ip: req.ip,
    });
    await audit(prisma, {
      userId: user.id, actor: 'user', eventType: 'auth.verified', requestId: req.id, ip: req.ip,
    });
    return reply.send({
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, role: user.role, name: user.name },
    });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const email = body.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) return reply.code(401).send({ error: 'invalid_credentials' });
    const ok = await verifySecret(body.password, user.passwordHash);
    if (!ok) {
      await audit(prisma, {
        userId: user.id, actor: 'user', eventType: 'auth.login_failed',
        requestId: req.id, ip: req.ip,
      });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    const { raw: refreshToken } = await issueRefreshToken(prisma, {
      userId: user.id, userAgent: req.headers['user-agent'], ip: req.ip,
    });
    await audit(prisma, {
      userId: user.id, actor: 'user', eventType: 'auth.login',
      requestId: req.id, ip: req.ip,
    });
    return reply.send({
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, role: user.role, name: user.name },
    });
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const body = RefreshBody.parse(req.body);
    const r = await rotateRefreshToken(prisma, body.refreshToken, {
      userAgent: req.headers['user-agent'], ip: req.ip,
    });
    if (!r.ok) return reply.code(401).send({ error: r.reason });
    const user = await prisma.user.findUnique({ where: { id: r.userId } });
    if (!user) return reply.code(401).send({ error: 'user_not_found' });
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    return reply.send({ accessToken, refreshToken: r.raw });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const body = LogoutBody.parse(req.body);
    await revokeRefreshToken(prisma, body.refreshToken);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
    const u = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    return { user: u ? { id: u.id, email: u.email, role: u.role, name: u.name, hasPin: !!u.pinHash } : null };
  });

  // Set/reset PIN — requerido antes de poder usar pago por voz
  app.post('/api/auth/pin', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = SetPinBody.parse(req.body);
    const pinHash = await hashSecret(body.pin);
    await prisma.user.update({ where: { id: req.auth!.userId }, data: { pinHash } });
    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'auth.pin_set',
      requestId: req.id, ip: req.ip,
    });
    return reply.send({ ok: true });
  });
}
