import jwt from 'jsonwebtoken';
import { sha256, randomToken } from './crypto.js';
import type { PrismaClient } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const secret = process.env.JWT_SECRET ?? 'dev-jwt-secret';
  const ttl = process.env.JWT_ACCESS_TTL ?? '15m';
  return jwt.sign(payload, secret, { expiresIn: ttl as jwt.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const secret = process.env.JWT_SECRET ?? 'dev-jwt-secret';
  return jwt.verify(token, secret) as AccessTokenPayload;
}

const REFRESH_TTL_DAYS = (() => {
  const raw = process.env.JWT_REFRESH_TTL ?? '30d';
  const m = /^(\d+)d$/.exec(raw);
  return m && m[1] ? Number(m[1]) : 30;
})();

export interface IssueRefreshOpts {
  userId: string;
  userAgent?: string;
  ip?: string;
}

export async function issueRefreshToken(prisma: PrismaClient, opts: IssueRefreshOpts) {
  const raw = randomToken(32);
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000);
  await prisma.refreshToken.create({
    data: {
      userId: opts.userId,
      tokenHash,
      expiresAt,
      userAgent: opts.userAgent,
      ip: opts.ip,
    },
  });
  return { raw, expiresAt };
}

export async function rotateRefreshToken(
  prisma: PrismaClient,
  rawToken: string,
  meta: { userAgent?: string; ip?: string },
) {
  const tokenHash = sha256(rawToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!existing) return { ok: false, reason: 'not_found' as const };
  if (existing.revokedAt) return { ok: false, reason: 'revoked' as const };
  if (existing.expiresAt < new Date()) return { ok: false, reason: 'expired' as const };

  // rotación: emite nuevo, revoca anterior y enlaza
  const fresh = await issueRefreshToken(prisma, { userId: existing.userId, ...meta });
  const freshHash = sha256(fresh.raw);
  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), replacedBy: freshHash },
  });
  return { ok: true as const, userId: existing.userId, raw: fresh.raw, expiresAt: fresh.expiresAt };
}

export async function revokeRefreshToken(prisma: PrismaClient, rawToken: string) {
  const tokenHash = sha256(rawToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllForUser(prisma: PrismaClient, userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
