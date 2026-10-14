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
    payload: { email: 'b66@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b66@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('subscription lifetime value', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/lifetime-value',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.totalSpent).toBe('0');
  });

  it('calculates lifetime value from subscriptions', async () => {
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'Pro', amount: BigInt(2999),
        currency: 'USD', interval: 'monthly', status: 'active',
      },
    });
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'Basic', amount: BigInt(999),
        currency: 'USD', interval: 'monthly', status: 'cancelled',
        cancelledAt: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/lifetime-value',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(2);
    expect(BigInt(body.totalSpent)).toBeGreaterThan(BigInt(0));
    expect(body.avgDurationMonths).toBeGreaterThan(0);
    expect(body.churnRate).toBeGreaterThan(0);
  });
});

describe('card fraud risk assessment', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/fraud-risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.riskLevel).toBe('none');
  });

  it('assesses fraud risk across cards', async () => {
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, last4: '1234', brand: 'visa',
        expiryMonth: 12, expiryYear: 2028,
        token: 'tok_1', holderName: 'Test User', country: 'US',
      },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, last4: '5678', brand: 'mastercard',
        expiryMonth: 1, expiryYear: 2024,
        token: 'tok_2', frozen: true,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/fraud-risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(2);
    expect(body.overallRiskScore).toBeGreaterThan(0);
    expect(body.cardRisks.length).toBe(2);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('transaction limit breach history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/breach-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.breachedCount).toBe(0);
  });

  it('tracks limit breach history', async () => {
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'USD', limitType: 'daily',
        maxAmount: BigInt(100000), currentUsage: BigInt(95000),
      },
    });
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'USD', limitType: 'monthly',
        maxAmount: BigInt(500000), currentUsage: BigInt(200000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/breach-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.nearBreachCount).toBe(1);
    expect(body.safeCount).toBe(1);
    expect(body.overallUtilization).toBeGreaterThan(0);
    expect(body.limits.length).toBe(2);
  });
});

describe('transaction anomaly detection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/anomaly-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.anomalies).toEqual([]);
  });

  it('detects anomalous transactions', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.transaction.create({
        data: {
          userId: ctx.user.id, walletId: wallet.id,
          amount: BigInt(1000), currency: 'USD',
          type: 'TRANSFER', status: 'completed',
          reference: `ref-normal-${i}`,
        },
      });
    }
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        amount: BigInt(100000), currency: 'USD',
        type: 'TRANSFER', status: 'completed',
        reference: 'ref-outlier',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/anomaly-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(6);
    expect(body.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(Number(body.stdDeviation)).toBeGreaterThan(0);
  });
});

describe('account completeness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('reports account completeness', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/account-completeness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(body.totalFields).toBeGreaterThan(0);
    expect(body.completenessPercent).toBeDefined();
    expect(body.level).toBeDefined();
    expect(body.fields.length).toBeGreaterThan(0);
  });

  it('tracks missing fields', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/account-completeness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.missingFields).toBeDefined();
    expect(body.missingFields.length).toBeGreaterThanOrEqual(0);
    expect(body.completedFields + body.missingFields.length).toBe(body.totalFields);
  });
});
