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
    payload: { email: 'b19@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b19@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('points leaderboard', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns ranked leaderboard', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 100, reason: 'test' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/leaderboard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].rank).toBe(1);
    expect(list[0].userId).toBe(ctx.user.id);
  });

  it('respects limit parameter', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 50, reason: 'test' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/leaderboard?limit=1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeLessThanOrEqual(1);
  });
});

describe('points history type filter', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('filters history by type', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 200, reason: 'signup' },
    });

    const earnOnly = await ctx.app.inject({
      method: 'GET', url: '/api/points/history?type=EARN',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(earnOnly.statusCode).toBe(200);
    expect(earnOnly.json().length).toBe(1);
    expect(earnOnly.json()[0].type).toBe('EARN');

    const redeemOnly = await ctx.app.inject({
      method: 'GET', url: '/api/points/history?type=REDEEM',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(redeemOnly.statusCode).toBe(200);
    expect(redeemOnly.json().length).toBe(0);
  });
});

describe('ant expenses dismissed list', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns dismissed expenses', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        category: 'subscriptions', merchantName: 'Netflix',
        amount: 15.99, currency: 'USD', frequency: 'monthly',
        monthlyTotal: 15.99, yearlyProjection: 191.88,
      },
    });
    const expenseId = created.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/ant-expenses/${expenseId}/dismiss`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/dismissed',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].isActive).toBe(false);
    expect(res.json()[0].merchantName).toBe('Netflix');
  });

  it('excludes active expenses from dismissed list', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        category: 'food', merchantName: 'DoorDash',
        amount: 30, currency: 'USD', frequency: 'weekly',
        monthlyTotal: 120, yearlyProjection: 1440,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/dismissed',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(0);
  });
});

describe('session history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns all sessions including revoked', async () => {
    const s1 = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        deviceId: 'dev-1', ip: '1.1.1.1',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    const s1Id = s1.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/sessions/${s1Id}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        deviceId: 'dev-2', ip: '2.2.2.2',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });

    const history = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().length).toBe(2);
  });

  it('active-only list excludes revoked sessions', async () => {
    const s1 = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        deviceId: 'dev-a', ip: '3.3.3.3',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/sessions/${s1.json().id}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const active = await ctx.app.inject({
      method: 'GET', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().length).toBe(0);
  });
});

describe('transaction limits dry-run check', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('reports allowed without incrementing usage', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 1000 },
    });

    const check = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits/check-available',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().allowed).toBe(true);

    const limit = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/USD/daily',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(limit.json().currentUsage).toBe('0');
  });

  it('reports not allowed when exceeding limit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 100 },
    });

    const check = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits/check-available',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 200 },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().allowed).toBe(false);
    expect(check.json().reason).toBe('daily_limit_exceeded');
  });

  it('returns allowed when no limits are set', async () => {
    const check = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits/check-available',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 9999 },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().allowed).toBe(true);
  });
});
