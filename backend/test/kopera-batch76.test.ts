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
    payload: { email: 'b76@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b76@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('subscription cost trend forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/cost-trend-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActive).toBe(0);
    expect(body.currentMonthlyCost).toBe('0');
    expect(body.trendDirection).toBe('stable');
  });

  it('forecasts cost with active subscriptions', async () => {
    await ctx.prisma.subscription.create({
      data: { userId: ctx.user.id, planId: 'plan-1', status: 'active', amount: BigInt(5000), currency: 'USD', interval: 'monthly', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
    await ctx.prisma.subscription.create({
      data: { userId: ctx.user.id, planId: 'plan-2', status: 'active', amount: BigInt(12000), currency: 'USD', interval: 'monthly', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/cost-trend-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActive).toBe(2);
    expect(Number(body.currentMonthlyCost)).toBeGreaterThan(0);
    expect(body.trendDirection).toBeDefined();
  });
});

describe('card expiry risk matrix', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/expiry-risk-matrix',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.riskLevel).toBe('no_data');
    expect(body.riskMatrix).toEqual([]);
  });

  it('assesses expiry risk with cards', async () => {
    await ctx.prisma.tokenizedCard.create({
      data: { userId: ctx.user.id, last4: '1234', brand: 'visa', token: 'tok-1', expiryDate: new Date(Date.now() + 10 * 86400000) },
    });
    await ctx.prisma.tokenizedCard.create({
      data: { userId: ctx.user.id, last4: '5678', brand: 'mastercard', token: 'tok-2', expiryDate: new Date(Date.now() + 200 * 86400000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/expiry-risk-matrix',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(2);
    expect(body.riskMatrix.length).toBe(2);
    expect(body.riskMatrix[0].riskCategory).toBe('critical');
    expect(body.riskMatrix[1].riskCategory).toBe('safe');
    expect(body.riskScore).toBeLessThan(100);
  });
});

describe('transaction limits efficiency index', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/efficiency-index',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.efficiencyLevel).toBe('no_data');
  });

  it('computes efficiency with seeded limits', async () => {
    await ctx.prisma.transactionLimit.create({
      data: { userId: ctx.user.id, currency: 'USD', limitType: 'daily', maxAmount: BigInt(100000), currentUsage: BigInt(50000), periodStart: new Date() },
    });
    await ctx.prisma.transactionLimit.create({
      data: { userId: ctx.user.id, currency: 'EUR', limitType: 'daily', maxAmount: BigInt(200000), currentUsage: BigInt(1000), periodStart: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/efficiency-index',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.efficiencyIndex).toBeGreaterThan(0);
    expect(body.optimalCount).toBe(1);
    expect(body.wastefulCount).toBe(1);
    expect(body.efficiencyLevel).toBeDefined();
  });
});

describe('transaction risk profile', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/risk-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.riskLevel).toBe('no_data');
  });

  it('profiles risk with mixed transactions', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(1000000), status: 'ACTIVE' },
    });
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.transaction.create({
        data: { userId: ctx.user.id, walletId: wallet.id, type: 'PAYMENT', amount: BigInt(1000), currency: 'USD', status: 'completed', reference: `ref-${i}` },
      });
    }
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, walletId: wallet.id, type: 'REVERSAL', amount: BigInt(500), currency: 'USD', status: 'completed', reference: 'ref-rev' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/risk-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(6);
    expect(body.unusualPatterns).toBe(1);
    expect(body.riskScore).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('account trust score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns trust score for basic user', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/trust-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(body.trustScore).toBeGreaterThanOrEqual(0);
    expect(body.trustLevel).toBeDefined();
    expect(body.factors.length).toBeGreaterThan(0);
  });

  it('improves score with more profile data', async () => {
    await ctx.prisma.user.update({
      where: { id: ctx.user.id },
      data: { firstName: 'Test', lastName: 'User', mfaEnabled: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/trust-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trustScore).toBeGreaterThan(0);
    const mfa = body.factors.find((f: any) => f.factor === 'mfa_enabled');
    expect(mfa.status).toBe('passed');
    const profile = body.factors.find((f: any) => f.factor === 'profile_complete');
    expect(profile.status).toBe('passed');
  });
});
