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
    payload: { email: 'b87@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b87@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('card renewal planner', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/renewal-planner',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.plannerLevel).toBe('no_data');
  });

  it('plans renewal with mixed card statuses', async () => {
    await ctx.prisma.tokenizedCard.create({
      data: { userId: ctx.user.id, last4: '1111', network: 'visa', token: 'tok1', expiryMonth: 12, expiryYear: 2030 },
    });
    await ctx.prisma.tokenizedCard.create({
      data: { userId: ctx.user.id, last4: '2222', network: 'mastercard', token: 'tok2', expiryMonth: 1, expiryYear: 2020 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/renewal-planner',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(2);
    expect(body.breakdown.needsRenewal).toBeGreaterThanOrEqual(1);
    expect(body.plannerLevel).toBeDefined();
  });
});

describe('limit usage trend analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/usage-trend-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.trendLevel).toBe('no_data');
  });

  it('analyzes usage trends with limits', async () => {
    await ctx.prisma.transactionLimit.create({
      data: { userId: ctx.user.id, currency: 'USD', limitType: 'daily', maxAmount: BigInt(100000), currentUsage: BigInt(80000), periodStart: new Date() },
    });
    await ctx.prisma.transactionLimit.create({
      data: { userId: ctx.user.id, currency: 'EUR', limitType: 'monthly', maxAmount: BigInt(500000), currentUsage: BigInt(50000), periodStart: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/usage-trend-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.avgUtilization).toBeGreaterThan(0);
    expect(body.trendLevel).toBeDefined();
  });
});

describe('transaction category insights', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/category-insights',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.insightLevel).toBe('no_data');
  });

  it('provides insights with transactions', async () => {
    const w = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000) },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, walletId: w.id, type: 'transfer', amount: BigInt(5000), currency: 'USD', status: 'completed', reference: 'TXN87A' },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, walletId: w.id, type: 'payment', amount: BigInt(3000), currency: 'USD', status: 'completed', reference: 'TXN87B' },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, walletId: w.id, type: 'transfer', amount: BigInt(2000), currency: 'USD', status: 'completed', reference: 'TXN87C' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/category-insights',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(3);
    expect(body.categories.length).toBeGreaterThanOrEqual(1);
    expect(body.insightLevel).toBeDefined();
  });
});

describe('profile data quality check', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns quality assessment for basic profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/data-quality',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.qualityScore).toBeDefined();
    expect(body.qualityLevel).toBeDefined();
    expect(body.totalFields).toBe(7);
  });

  it('detects missing fields', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/data-quality',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.missingFields.length).toBeGreaterThanOrEqual(0);
    expect(body.completionRate).toBeDefined();
    expect(body.recommendations.length).toBeGreaterThanOrEqual(0);
  });
});

describe('session retention metrics', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns metrics for existing sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/retention-metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBeGreaterThanOrEqual(0);
    expect(body.retentionLevel).toBeDefined();
  });

  it('calculates retention with sessions', async () => {
    await ctx.prisma.userSession.create({
      data: { userId: ctx.user.id, token: 'sess87a', ipAddress: '10.0.0.1', userAgent: 'test', expiresAt: new Date(Date.now() + 86400000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/retention-metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBeGreaterThanOrEqual(1);
    expect(body.retentionScore).toBeGreaterThan(0);
    expect(body.retentionLevel).toBeDefined();
  });
});
