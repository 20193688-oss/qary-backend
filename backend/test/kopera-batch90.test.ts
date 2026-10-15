import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryPrisma, createInMemoryRedis, createMockStripe } from './_mocks.js';

async function bootstrap() {
  const prisma = createInMemoryPrisma();
  const redis = createInMemoryRedis();
  const stripe = createMockStripe();
  const app = await buildApp({ prisma, redis, stripe: stripe as never });
  await app.ready();

  const reg = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'b90@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b90@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('audit trail', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('logs an action', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/audit-trail/log',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { action: 'WALLET_CREATED', resourceType: 'wallet', resourceId: 'w1', details: 'Created USD wallet' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().action).toBe('WALLET_CREATED');
    expect(res.json().integrityHash).toBeTruthy();
  });

  it('lists entries', async () => {
    await ctx.prisma.auditTrailEntry.create({
      data: { userId: ctx.user.id, action: 'LOGIN', resourceType: 'session', resourceId: 's1', performedAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/audit-trail/entries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets entries by resource', async () => {
    await ctx.prisma.auditTrailEntry.create({
      data: { userId: ctx.user.id, action: 'DEPOSIT', resourceType: 'wallet', resourceId: 'w1', performedAt: new Date() },
    });
    await ctx.prisma.auditTrailEntry.create({
      data: { userId: ctx.user.id, action: 'WITHDRAW', resourceType: 'wallet', resourceId: 'w1', performedAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/audit-trail/resource/wallet/w1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets a single entry', async () => {
    const entry = await ctx.prisma.auditTrailEntry.create({
      data: { userId: ctx.user.id, action: 'TRANSFER', resourceType: 'wallet', resourceId: 'w2', performedAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/audit-trail/${entry.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('TRANSFER');
  });

  it('returns no_data audit analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/audit-trail/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEntries).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('returns audit analytics with data', async () => {
    await ctx.prisma.auditTrailEntry.create({
      data: { userId: ctx.user.id, action: 'LOGIN', resourceType: 'session', resourceId: 's1' },
    });
    await ctx.prisma.auditTrailEntry.create({
      data: { userId: ctx.user.id, action: 'LOGIN', resourceType: 'session', resourceId: 's2' },
    });
    await ctx.prisma.auditTrailEntry.create({
      data: { userId: ctx.user.id, action: 'DEPOSIT', resourceType: 'wallet', resourceId: 'w1' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/audit-trail/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEntries).toBe(3);
    expect(res.json().actionBreakdown.LOGIN).toBe(2);
    expect(res.json().actionBreakdown.DEPOSIT).toBe(1);
  });
});

describe('API key management', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an API key', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/api-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Production Key', permissions: ['read', 'write'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Production Key');
    expect(res.json().rawKey).toMatch(/^kp_/);
    expect(res.json().keyHash).toBeUndefined();
  });

  it('lists API keys', async () => {
    await ctx.prisma.apiKey.create({
      data: { userId: ctx.user.id, name: 'Test', keyHash: 'hash', keyPrefix: 'kp_test', permissions: '["read"]' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/api-keys/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].keyHash).toBeUndefined();
  });

  it('validates a correct API key', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/api-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Validate Key', permissions: ['read'] },
    });
    const rawKey = create.json().rawKey;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/api-keys/validate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { apiKey: rawKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it('rejects invalid API key', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/api-keys/validate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { apiKey: 'kp_invalid' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  it('revokes an API key', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/api-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Revoke Key', permissions: ['read'] },
    });
    const keyId = create.json().id;
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/api-keys/${keyId}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('returns no_data API key analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/api-keys/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalKeys).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('rate limit configuration', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('sets a rate limit', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/rate-limit-configs/set',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { endpoint: '/api/payments', maxRequests: 100, windowSeconds: 60 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().endpoint).toBe('/api/payments');
    expect(res.json().strategy).toBe('fixed_window');
  });

  it('lists rate limit configs', async () => {
    await ctx.prisma.rateLimitConfig.create({
      data: { userId: ctx.user.id, endpoint: '/api/test', maxRequests: 50, windowSeconds: 60 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/rate-limit-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('checks a rate limit', async () => {
    await ctx.prisma.rateLimitConfig.create({
      data: { userId: ctx.user.id, endpoint: '/api/payments', maxRequests: 100, windowSeconds: 60, isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/rate-limit-configs/check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { endpoint: '/api/payments' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().limited).toBe(true);
    expect(res.json().config.maxRequests).toBe(100);
  });

  it('toggles a rate limit', async () => {
    const config = await ctx.prisma.rateLimitConfig.create({
      data: { userId: ctx.user.id, endpoint: '/api/test', maxRequests: 50, windowSeconds: 60, isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/rate-limit-configs/${config.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('removes a rate limit', async () => {
    const config = await ctx.prisma.rateLimitConfig.create({
      data: { userId: ctx.user.id, endpoint: '/api/test', maxRequests: 50, windowSeconds: 60 },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/rate-limit-configs/${config.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('gets a single rate limit config', async () => {
    const config = await ctx.prisma.rateLimitConfig.create({
      data: { userId: ctx.user.id, endpoint: '/api/transfers', maxRequests: 200, windowSeconds: 120, strategy: 'sliding_window' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/rate-limit-configs/${config.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().endpoint).toBe('/api/transfers');
    expect(res.json().strategy).toBe('sliding_window');
  });

  it('returns no_data rate limit analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/rate-limit-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConfigs).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('returns rate limit analytics with data', async () => {
    await ctx.prisma.rateLimitConfig.create({
      data: { userId: ctx.user.id, endpoint: '/api/a', maxRequests: 100, windowSeconds: 60, isActive: true },
    });
    await ctx.prisma.rateLimitConfig.create({
      data: { userId: ctx.user.id, endpoint: '/api/b', maxRequests: 200, windowSeconds: 120, isActive: true, strategy: 'sliding_window' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/rate-limit-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConfigs).toBe(2);
    expect(res.json().activeConfigs).toBe(2);
    expect(res.json().analyticsLevel).toBe('configured');
  });
});
