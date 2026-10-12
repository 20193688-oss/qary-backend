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
    payload: { email: 'b38@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b38@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('referral ROI analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns ROI after referral activity', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'referred38@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'referred38@kopera.io', code: reg2.json().debugOtp },
    });
    const referredToken = v2.json().accessToken;

    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const code = codeRes.json().code;

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${referredToken}` },
      payload: { code },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/reward',
      headers: { authorization: `Bearer ${referredToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/roi',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasCode).toBe(true);
    expect(body.signupCount).toBe(1);
    expect(body.rewardedCount).toBe(1);
    expect(body.totalPointsEarned).toBe(500);
    expect(body.pointsPerSignup).toBe(500);
    expect(body.pointsPerReward).toBe(500);
    expect(body.conversionRate).toBe(100);
    expect(body.pendingCount).toBe(0);
  });

  it('returns empty ROI without referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/roi',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasCode).toBe(false);
    expect(body.signupCount).toBe(0);
    expect(body.pointsPerSignup).toBe(0);
    expect(body.conversionRate).toBe(0);
  });
});

describe('transaction limit health check', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns health check after setting limits', async () => {
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
      method: 'GET', url: '/api/transaction-limits/health-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.overallHealth).toBeDefined();
    expect(body.recommendations).toBeInstanceOf(Array);
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details).toHaveLength(2);
    expect(typeof body.details[0].maxAmount).toBe('string');
    expect(typeof body.details[0].currentUsage).toBe('string');
    expect(typeof body.details[0].headroom).toBe('string');
    expect(body.details[0].assessment).toBeDefined();
  });

  it('returns empty health check with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/health-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.overallHealth).toBe('healthy');
    expect(body.details).toHaveLength(0);
    expect(body.recommendations).toHaveLength(0);
  });
});

describe('wallet consolidation report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns consolidation report after creating wallets', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/consolidation-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(2);
    expect(body.activeCount).toBe(2);
    expect(body.frozenCount).toBe(0);
    expect(body.closedCount).toBe(0);
    expect(body.zeroBalanceCount).toBe(1);
    expect(typeof body.totalBalance).toBe('string');
    expect(typeof body.totalHold).toBe('string');
    expect(body.byCurrency.USD).toBeDefined();
    expect(body.byCurrency.PEN).toBeDefined();
    expect(body.recommendations).toBeInstanceOf(Array);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });

  it('returns empty consolidation with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/consolidation-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(0);
    expect(body.activeCount).toBe(0);
    expect(body.totalBalance).toBe('0');
    expect(body.recommendations).toHaveLength(0);
  });
});

describe('points redemption analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns analysis after earning and redeeming', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 1000, reason: 'bonus' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 500, reason: 'referral' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/points/redeem',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 300, reason: 'cashback' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/redemption-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEarned).toBe(1500);
    expect(body.totalRedeemed).toBe(300);
    expect(body.balance).toBe(1200);
    expect(body.redemptionRate).toBe(20);
    expect(body.earnCount).toBe(2);
    expect(body.redeemCount).toBe(1);
    expect(body.avgEarnAmount).toBe(750);
    expect(body.avgRedeemAmount).toBe(300);
    expect(body.trend).toBeInstanceOf(Array);
    expect(body.trend.length).toBeGreaterThan(0);
  });

  it('returns empty analysis with no points activity', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/redemption-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEarned).toBe(0);
    expect(body.totalRedeemed).toBe(0);
    expect(body.balance).toBe(0);
    expect(body.redemptionRate).toBe(0);
    expect(body.trend).toHaveLength(0);
  });
});

describe('scheduled transfer cost projection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns projection after creating scheduled transfers', async () => {
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'recipient38@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'recipient38@kopera.io', code: reg2.json().debugOtp },
    });
    const recipientId = v2.json().user.id;

    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: recipientId, currency: 'USD', amount: 100, frequency: 'weekly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: recipientId, currency: 'USD', amount: 500, frequency: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/cost-projection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.periodDays).toBe(90);
    expect(body.activeTransfers).toBe(2);
    expect(body.projectedByCurrency.USD).toBeDefined();
    expect(typeof body.projectedByCurrency.USD).toBe('string');
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details).toHaveLength(2);
    expect(typeof body.details[0].amount).toBe('string');
    expect(typeof body.details[0].projectedCost).toBe('string');
    expect(body.details[0].executionsInPeriod).toBeGreaterThan(0);
  });

  it('returns empty projection with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/cost-projection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.periodDays).toBe(90);
    expect(body.activeTransfers).toBe(0);
    expect(body.details).toHaveLength(0);
    expect(Object.keys(body.projectedByCurrency)).toHaveLength(0);
  });
});
