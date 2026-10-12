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
    payload: { email: 'b25@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b25@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('notification stats', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns stats after sending notifications', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'alert', channel: 'PUSH', body: 'msg1' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'promo', channel: 'EMAIL', body: 'msg2' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(2);
    expect(res.json().unreadCount).toBeGreaterThanOrEqual(2);
    expect(res.json().byType.alert).toBeGreaterThanOrEqual(1);
    expect(res.json().byChannel.PUSH).toBeGreaterThanOrEqual(1);
  });

  it('returns valid structure with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('total');
    expect(res.json()).toHaveProperty('readCount');
    expect(res.json()).toHaveProperty('unreadCount');
    expect(res.json()).toHaveProperty('byType');
    expect(res.json()).toHaveProperty('byChannel');
  });
});

describe('scheduled transfer summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns summary with active transfers', async () => {
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'recip25@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'recip25@kopera.io', code: reg2.json().debugOtp },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: v2.json().user.id, currency: 'USD', amount: 50, frequency: 'weekly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: v2.json().user.id, currency: 'USD', amount: 100, frequency: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeCount).toBe(2);
    expect(res.json().totalCount).toBe(2);
    expect(res.json().byFrequency.weekly).toBe(1);
    expect(res.json().byFrequency.monthly).toBe(1);
    expect(Number(res.json().totalAmountByCurrency.USD)).toBeGreaterThan(0);
  });

  it('returns zeros when no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeCount).toBe(0);
    expect(res.json().totalCount).toBe(0);
    expect(res.json().nextUpcoming).toBeNull();
  });
});

describe('transaction limits usage summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns usage summary with limits set', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 1000 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'monthly', maxAmount: 10000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/usage-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLimits).toBe(2);
    expect(res.json().byType.daily).toBe(1);
    expect(res.json().byType.monthly).toBe(1);
    expect(Number(res.json().totalMaxAmount)).toBeGreaterThan(0);
    expect(res.json().utilizationPercent).toBe(0);
  });

  it('returns zeros when no limits set', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/usage-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLimits).toBe(0);
    expect(res.json().utilizationPercent).toBe(0);
  });
});

describe('fx bulk rate lookup', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns rates for multiple pairs', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/rates/bulk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        pairs: [
          { base: 'USD', quote: 'PEN' },
          { base: 'USD', quote: 'MXN' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].baseCurrency).toBe('USD');
    expect(body[0].quoteCurrency).toBe('PEN');
    expect(body[0].bid).toBeGreaterThan(0);
    expect(body[1].quoteCurrency).toBe('MXN');
  });

  it('returns error entries for unknown pairs', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/rates/bulk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        pairs: [{ base: 'ZZZ', quote: 'YYY' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].error).toBe('rate_not_available');
  });
});

describe('recent beneficiaries', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns recently added beneficiaries', async () => {
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'ben25@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'ben25@kopera.io', code: reg2.json().debugOtp },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Alice', recipientUserId: v2.json().user.id },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/recent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    expect(res.json()[0].nickname).toBe('Alice');
  });

  it('returns empty array when no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/recent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
