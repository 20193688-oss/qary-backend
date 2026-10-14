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
    payload: { email: 'b61@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b61@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('subscriptions plan popularity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/plan-popularity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.mostUsedPlan).toBeNull();
  });

  it('analyzes plan popularity', async () => {
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planId: 'pro', planName: 'Pro',
        amount: BigInt(2999), currency: 'USD', interval: 'monthly',
        status: 'active',
        currentPeriodStart: new Date(Date.now() - 60 * 86400000),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planId: 'basic', planName: 'Basic',
        amount: BigInt(999), currency: 'USD', interval: 'monthly',
        status: 'cancelled',
        currentPeriodStart: new Date(Date.now() - 120 * 86400000),
        currentPeriodEnd: new Date(Date.now() - 60 * 86400000),
        cancelledAt: new Date(Date.now() - 60 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/plan-popularity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(2);
    expect(body.activePlans).toBe(1);
    expect(body.byPlan.length).toBe(2);
    expect(body.mostUsedPlan).toBeDefined();
    expect(body.avgDurationDays).toBeGreaterThan(0);
  });
});

describe('tokenized cards spending by card', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/spending-by-card',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.totalSpent).toBe('0');
  });

  it('analyzes spending by card', async () => {
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, lastFour: '1234', network: 'VISA',
        token: 'tok_1', expiryMonth: 12, expiryYear: 2027,
        status: 'active',
      },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, lastFour: '5678', network: 'MASTERCARD',
        token: 'tok_2', expiryMonth: 6, expiryYear: 2026,
        status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/spending-by-card',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(2);
    expect(body.byCard.length).toBe(2);
  });
});

describe('transaction limits compliance report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns all compliant with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/compliance-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.complianceRate).toBe(100);
  });

  it('reports compliance status of limits', async () => {
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'USD', limitType: 'daily',
        maxAmount: BigInt(100000), currentUsage: BigInt(50000),
        periodStart: new Date(),
      },
    });
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'USD', limitType: 'monthly',
        maxAmount: BigInt(500000), currentUsage: BigInt(450000),
        periodStart: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/compliance-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.nearLimitCount + body.compliantCount + body.exceededCount).toBe(2);
    expect(body.byLimitType.length).toBeGreaterThan(0);
    expect(body.complianceRate).toBeDefined();
  });
});

describe('transactions peak activity analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/peak-activity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.peakHour).toBeNull();
    expect(body.byHour.length).toBe(24);
  });

  it('analyzes peak activity patterns', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    for (let i = 0; i < 6; i++) {
      await ctx.prisma.transaction.create({
        data: {
          userId: ctx.user.id, walletId: wallet.id,
          type: 'CREDIT', amount: BigInt(1000 * (i + 1)), currency: 'USD',
          status: 'COMPLETED', reference: `peak-${i}`,
          createdAt: new Date(2025, 5, 10 + i, 14, 30),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/peak-activity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(6);
    expect(body.peakHour).toBeDefined();
    expect(body.peakDay).toBeDefined();
    expect(body.byDayOfWeek.length).toBe(7);
    expect(body.weekdayVsWeekend).toBeDefined();
  });
});

describe('user profile account maturity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns basic maturity for new user', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/account-maturity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountAgeDays).toBeGreaterThanOrEqual(0);
    expect(body.maturityLevel).toBeDefined();
    expect(body.adoptionRate).toBeGreaterThanOrEqual(0);
    expect(body.features).toBeDefined();
  });

  it('detects feature adoption with wallets and cards', async () => {
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, lastFour: '9999', network: 'VISA',
        token: 'tok_m', expiryMonth: 12, expiryYear: 2028,
        status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/account-maturity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.features.hasWallet).toBe(true);
    expect(body.features.hasCard).toBe(true);
    expect(body.featureAdoption).toBeGreaterThanOrEqual(2);
    expect(body.totalCards).toBe(1);
  });
});
