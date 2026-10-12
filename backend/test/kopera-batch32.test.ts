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
    payload: { email: 'b32@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b32@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ant expense savings impact report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns impact after tracking expenses', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { category: 'coffee', merchantName: 'Starbucks', amount: 5, currency: 'USD', frequency: 'daily', monthlyTotal: 150, yearlyProjection: 1800, savingsIfCut: 1200 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/savings-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeCount).toBe(1);
    expect(res.json().byCurrency.USD).toBeDefined();
    expect(res.json().highestImpact).toBeDefined();
    expect(res.json().highestImpact.merchantName).toBe('Starbucks');
  });

  it('returns empty report with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/savings-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTracked).toBe(0);
    expect(res.json().activeCount).toBe(0);
  });
});

describe('invoice collection efficiency', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns efficiency after issuing and paying invoices', async () => {
    const inv = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'FACTURA', currency: 'USD', subtotal: 100, country: 'US', senderName: 'Test Corp' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${inv.json().id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/collection-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().paidCount).toBe(1);
    expect(res.json().collectionRate).toBeGreaterThan(0);
    expect(typeof res.json().totalRevenue).toBe('string');
  });

  it('returns empty efficiency with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/collection-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalIssued).toBe(0);
    expect(res.json().collectionRate).toBe(0);
  });
});

describe('payment link conversion report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns conversion data after creating links', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD', description: 'Test payment' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/conversion-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLinks).toBe(1);
    expect(typeof res.json().totalRevenue).toBe('string');
    expect(typeof res.json().conversionRate).toBe('number');
  });

  it('returns empty report with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/conversion-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLinks).toBe(0);
    expect(res.json().conversionRate).toBe(0);
  });
});

describe('referral reward timeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns timeline after creating referral code', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/reward-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasCode).toBe(true);
    expect(res.json().totalSignups).toBe(0);
    expect(typeof res.json().rewardRate).toBe('number');
  });

  it('returns empty timeline with no referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/reward-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasCode).toBe(false);
    expect(res.json().totalSignups).toBe(0);
  });
});

describe('transaction limit utilization report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns utilization after setting limits', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 1000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/utilization-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLimits).toBe(1);
    expect(res.json().details).toHaveLength(1);
    expect(res.json().details[0].nearLimit).toBe(false);
    expect(typeof res.json().details[0].headroom).toBe('string');
  });

  it('returns empty report with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/utilization-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLimits).toBe(0);
    expect(res.json().nearLimitCount).toBe(0);
  });
});
