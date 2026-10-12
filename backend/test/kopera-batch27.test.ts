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
    payload: { email: 'b27@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b27@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('transaction monthly breakdown', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 12 months of data after deposits', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });

    const year = new Date().getFullYear();
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/transaction-history/monthly/USD?year=${year}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(12);
    const currentMonth = res.json().find((m: any) => m.month === new Date().getMonth() + 1);
    expect(Number(currentMonth.totalIn)).toBeGreaterThan(0);
    expect(currentMonth.transactionCount).toBeGreaterThanOrEqual(1);
  });

  it('returns all zeros for a year with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/monthly/USD?year=2020',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(12);
    expect(res.json().every((m: any) => m.transactionCount === 0)).toBe(true);
  });
});

describe('transaction type distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns distribution after transactions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 200 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/distribution?currency=USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTransactions).toBeGreaterThanOrEqual(1);
    expect(res.json().byType.DEPOSIT).toBeDefined();
    expect(res.json().byType.DEPOSIT.count).toBeGreaterThanOrEqual(1);
  });

  it('returns zeros when no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTransactions).toBe(0);
  });
});

describe('savings goal progress', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns progress for a goal with contributions', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation', targetAmount: 1000, currency: 'USD' },
    });
    const goalId = createRes.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${goalId}/contribute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 250 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/savings-goals/${goalId}/progress`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().progressPercent).toBe(25);
    expect(Number(res.json().remaining)).toBeGreaterThan(0);
    expect(res.json().status).toBe('active');
  });

  it('returns 404 for nonexistent goal', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/nonexistent/progress',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('subscription renewal countdown', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns renewals for active subscriptions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 29.99, currency: 'USD', interval: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/renewals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    expect(res.json()[0].daysUntilRenewal).toBeGreaterThanOrEqual(0);
    expect(res.json()[0].planName).toBe('Pro');
  });

  it('returns empty when no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/renewals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('payment link expiring soon', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns links expiring within the window', async () => {
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD', expiresAt },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/expiring?days=7',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    expect(res.json()[0].daysRemaining).toBeLessThanOrEqual(7);
  });

  it('returns empty when no expiring links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/expiring',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
