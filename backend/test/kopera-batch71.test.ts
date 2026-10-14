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
    payload: { email: 'b71@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b71@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('subscription overlap analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/overlap-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.activeCount).toBe(0);
  });

  it('detects overlapping subscriptions', async () => {
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'premium', amount: BigInt(2000),
        currency: 'USD', status: 'active', billingCycle: 'monthly',
      },
    });
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'premium', amount: BigInt(2000),
        currency: 'USD', status: 'active', billingCycle: 'monthly',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/overlap-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(2);
    expect(body.activeCount).toBe(2);
    expect(body.overlapGroups.length).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('card utilization trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/utilization-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.activeCards).toBe(0);
  });

  it('analyzes card utilization', async () => {
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, last4: '1234', brand: 'visa',
        token: 'tok_1', expiryMonth: 12, expiryYear: 2027, status: 'active',
      },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, last4: '5678', brand: 'mastercard',
        token: 'tok_2', expiryMonth: 6, expiryYear: 2025, status: 'expired',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/utilization-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(2);
    expect(body.cardTrends.length).toBe(2);
  });
});

describe('limit adjustment recommendation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/adjustment-recommendation',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.overallUtilization).toBe(0);
  });

  it('recommends limit adjustments', async () => {
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'USD', limitType: 'daily',
        maxAmount: BigInt(100000), currentUsage: BigInt(95000),
        periodStart: new Date(),
      },
    });
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'EUR', limitType: 'daily',
        maxAmount: BigInt(50000), currentUsage: BigInt(1000),
        periodStart: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/adjustment-recommendation',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.adjustments.length).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('transaction correlation analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/correlation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.dominantFlow).toBeNull();
  });

  it('analyzes transaction correlations', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'DEPOSIT',
        amount: BigInt(5000), currency: 'USD', status: 'completed',
        reference: 'ref-1',
      },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'TRANSFER',
        amount: BigInt(3000), currency: 'USD', status: 'completed',
        reference: 'ref-2',
      },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'DEPOSIT',
        amount: BigInt(7000), currency: 'USD', status: 'completed',
        reference: 'ref-3',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/correlation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(3);
    expect(body.typePairs.length).toBeGreaterThan(0);
    expect(body.dominantFlow).toBeDefined();
  });
});

describe('profile risk indicators', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns risk indicators for user', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/risk-indicators',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(body.totalIndicators).toBeGreaterThanOrEqual(0);
    expect(body.riskScore).toBeGreaterThanOrEqual(0);
    expect(body.riskLevel).toBeDefined();
    expect(body.indicators).toBeDefined();
  });

  it('detects missing security features', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/risk-indicators',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.indicators.length).toBeGreaterThan(0);
    const hasNoMfa = body.indicators.some((i: any) => i.indicator === 'no_mfa');
    expect(hasNoMfa).toBe(true);
  });
});
