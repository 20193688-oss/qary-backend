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
    payload: { email: 'b65@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b65@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment link abandonment analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no payment links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/abandonment-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.abandonmentRate).toBe(0);
  });

  it('analyzes payment link abandonment', async () => {
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, code: 'LINK1', amount: BigInt(5000),
        currency: 'USD', status: 'active', timesUsed: 0,
      },
    });
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, code: 'LINK2', amount: BigInt(10000),
        currency: 'USD', status: 'active', timesUsed: 3,
        lastUsedAt: new Date(),
      },
    });
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, code: 'LINK3', amount: BigInt(2000),
        currency: 'USD', status: 'deactivated', timesUsed: 0,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/abandonment-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(3);
    expect(body.abandonedCount).toBe(1);
    expect(body.usedCount).toBe(1);
    expect(body.deactivatedCount).toBe(1);
    expect(body.byStatus.length).toBeGreaterThan(0);
    expect(BigInt(body.abandonedValue)).toBe(BigInt(5000));
  });
});

describe('points seasonality analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no points account', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/seasonality-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.seasonalTrend).toBe('insufficient_data');
  });

  it('analyzes points seasonality', async () => {
    const pts = await ctx.prisma.koperaPoints.create({
      data: { userId: ctx.user.id, balance: 500, tier: 'SILVER', lifetimeEarned: 800, lifetimeSpent: 300 },
    });
    await ctx.prisma.pointsHistory.create({
      data: { pointsId: pts.id, amount: 500, type: 'EARN', reason: 'purchase', createdAt: new Date(2025, 0, 15) },
    });
    await ctx.prisma.pointsHistory.create({
      data: { pointsId: pts.id, amount: 300, type: 'EARN', reason: 'bonus', createdAt: new Date(2025, 0, 20) },
    });
    await ctx.prisma.pointsHistory.create({
      data: { pointsId: pts.id, amount: -100, type: 'REDEEM', reason: 'reward', createdAt: new Date(2025, 5, 10) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/seasonality-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(3);
    expect(body.byMonth.length).toBeGreaterThanOrEqual(1);
    expect(body.peakEarningMonth).toBe('Jan');
    expect(body.seasonalTrend).toBe('earning_dominant');
  });
});

describe('referral chain depth', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/chain-depth',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.chainDepth).toBe(0);
  });

  it('analyzes referral chain depth', async () => {
    const ref = await ctx.prisma.referral.create({
      data: {
        userId: ctx.user.id, code: 'REF65A',
        status: 'active', signupCount: 2, rewardedCount: 1, totalPointsEarned: 100,
      },
    });
    await ctx.prisma.referralSignup.create({
      data: {
        referralId: ref.id, referredUserId: 'user-a',
        status: 'rewarded', rewardedAt: new Date(),
      },
    });
    await ctx.prisma.referralSignup.create({
      data: {
        referralId: ref.id, referredUserId: 'user-b',
        status: 'signed_up',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/chain-depth',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.totalSignups).toBe(2);
    expect(body.chainDepth).toBeGreaterThanOrEqual(1);
    expect(body.signupsByStatus.length).toBeGreaterThan(0);
    expect(body.conversionFunnel.signed_up).toBe(2);
    expect(body.conversionFunnel.rewarded).toBe(1);
  });
});

describe('savings goal correlation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no savings goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/goal-correlation',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.avgProgress).toBe(0);
  });

  it('correlates savings goals', async () => {
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Vacation',
        targetAmount: BigInt(100000), currentAmount: BigInt(50000),
        currency: 'USD', status: 'active',
      },
    });
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Emergency Fund',
        targetAmount: BigInt(200000), currentAmount: BigInt(180000),
        currency: 'USD', status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/goal-correlation',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(2);
    expect(body.activeGoals).toBe(2);
    expect(body.avgProgress).toBeGreaterThan(0);
    expect(BigInt(body.totalSaved)).toBe(BigInt(230000));
    expect(BigInt(body.totalTarget)).toBe(BigInt(300000));
    expect(body.goalPairs.length).toBe(1);
  });
});

describe('scheduled transfer currency exposure', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no scheduled transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/currency-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveTransfers).toBe(0);
    expect(body.diversificationScore).toBe(0);
  });

  it('analyzes currency exposure across transfers', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        recipientId: 'recip-1', amount: BigInt(10000),
        currency: 'USD', frequency: 'monthly',
        nextExecutionDate: new Date(), status: 'active',
      },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        recipientId: 'recip-2', amount: BigInt(5000),
        currency: 'EUR', frequency: 'weekly',
        nextExecutionDate: new Date(), status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/currency-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveTransfers).toBe(2);
    expect(body.currencies.length).toBe(2);
    expect(body.diversificationScore).toBeGreaterThan(0);
    expect(body.dominantCurrency).toBeDefined();
    expect(BigInt(body.totalMonthlyVolume)).toBe(BigInt(15000));
  });
});
