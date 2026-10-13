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
    payload: { email: 'b51@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b51@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('cards bank distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/bank-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.distinctBanks).toBe(0);
    expect(body.byBank).toBeInstanceOf(Array);
    expect(body.dominantBank).toBeNull();
  });

  it('groups cards by bank name', async () => {
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, vaultToken: 'vt1', last4: '1111',
        network: 'VISA', expiryMonth: 12, expiryYear: 2027,
        bankName: 'Chase', isDefault: true,
      },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, vaultToken: 'vt2', last4: '2222',
        network: 'MASTERCARD', expiryMonth: 6, expiryYear: 2028,
        bankName: 'Chase', isDefault: false,
      },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, vaultToken: 'vt3', last4: '3333',
        network: 'VISA', expiryMonth: 3, expiryYear: 2026,
        bankName: 'BoA', isDefault: false,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/bank-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(3);
    expect(body.distinctBanks).toBe(2);
    expect(body.dominantBank).toBe('Chase');
    expect(body.byBank[0].count).toBe(2);
    expect(body.byBank[0].share).toBeCloseTo(66.67, 0);
  });
});

describe('transaction limits currency breakdown', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/currency-breakdown',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.distinctCurrencies).toBe(0);
    expect(body.byCurrency).toBeInstanceOf(Array);
  });

  it('aggregates limits by currency', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 1000 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'monthly', maxAmount: 20000 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'EUR', limitType: 'daily', maxAmount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/currency-breakdown',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(3);
    expect(body.distinctCurrencies).toBe(2);
    const usd = body.byCurrency.find((c: any) => c.currency === 'USD');
    expect(usd).toBeDefined();
    expect(usd.dailyLimits).toBe(1);
    expect(usd.monthlyLimits).toBe(1);
  });
});

describe('transaction fee analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zeros with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/fee-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.totalFees).toBe('0');
    expect(body.feeToAmountRatio).toBe(0);
  });

  it('analyzes fees from completed transactions', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(100000), status: 'ACTIVE', isDefault: true },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'PAYMENT',
        amount: BigInt(10000), currency: 'USD', status: 'COMPLETED',
        feeAmount: BigInt(100), description: 'Payment 1',
      },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'TRANSFER',
        amount: BigInt(5000), currency: 'USD', status: 'COMPLETED',
        feeAmount: BigInt(50), description: 'Transfer 1',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/fee-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(2);
    expect(body.totalFees).toBe('150');
    expect(body.feeToAmountRatio).toBeGreaterThan(0);
    expect(body.byType.PAYMENT).toBeDefined();
    expect(body.byType.PAYMENT.count).toBe(1);
    expect(body.byType.PAYMENT.totalFees).toBe('100');
  });
});

describe('profile security scorecard', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns scorecard for new user', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/security-scorecard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.score).toBeDefined();
    expect(body.level).toBeDefined();
    expect(body.checklist).toBeInstanceOf(Array);
    expect(body.totalChecks).toBeGreaterThan(0);
    expect(body.accountAgeDays).toBeGreaterThanOrEqual(0);
  });

  it('improves score with MFA enabled', async () => {
    const before = await ctx.app.inject({
      method: 'GET', url: '/api/profile/security-scorecard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const scoreBefore = before.json().score;

    await ctx.app.inject({
      method: 'POST', url: '/api/profile/mfa/enable',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secret: 'test-mfa-secret' },
    });

    const after = await ctx.app.inject({
      method: 'GET', url: '/api/profile/security-scorecard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const scoreAfter = after.json().score;
    expect(scoreAfter).toBeGreaterThan(scoreBefore);
  });
});

describe('sessions login frequency', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/login-frequency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(0);
    expect(body.byDayOfWeek).toBeInstanceOf(Array);
    expect(body.byHourOfDay).toBeInstanceOf(Array);
    expect(body.peakDay).toBeNull();
    expect(body.avgSessionsPerWeek).toBe(0);
  });

  it('analyzes login patterns from sessions', async () => {
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.userSession.create({
        data: {
          userId: ctx.user.id, deviceId: `dev-${i}`, ip: '1.2.3.4',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/login-frequency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(3);
    expect(body.peakDay).toBeDefined();
    expect(body.peakHour).toBeDefined();
    expect(body.avgSessionsPerWeek).toBeGreaterThan(0);
    expect(body.recentVsPrior.last7Days).toBe(3);
    expect(body.byDayOfWeek.length).toBe(7);
    expect(body.byHourOfDay.length).toBe(24);
  });
});
