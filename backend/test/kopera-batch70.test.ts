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
    payload: { email: 'b70@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b70@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment link recurrence analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/recurrence-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.singleUseCount).toBe(0);
  });

  it('analyzes link recurrence', async () => {
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, code: 'LINK1', amount: BigInt(5000),
        currency: 'USD', status: 'USED',
      },
    });
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, code: 'LINK2', amount: BigInt(3000),
        currency: 'USD', status: 'ACTIVE',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/recurrence-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(2);
    expect(body.singleUseCount).toBe(1);
    expect(body.avgUsesPerLink).toBeGreaterThanOrEqual(0);
  });
});

describe('points concentration analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no history', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/concentration-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.concentrationScore).toBe(0);
  });

  it('analyzes points concentration', async () => {
    await ctx.prisma.koperaPoints.create({
      data: { userId: ctx.user.id, balance: 100, lifetimeEarned: 100, lifetimeRedeemed: 0 },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, type: 'EARN', amount: 50, reason: 'signup_bonus' },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, type: 'EARN', amount: 50, reason: 'referral' },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, type: 'REDEEM', amount: 20, reason: 'cashback' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/concentration-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(3);
    expect(body.earnTransactions).toBe(2);
    expect(body.redeemTransactions).toBe(1);
    expect(body.topEarnReasons.length).toBeGreaterThan(0);
    expect(body.concentrationScore).toBeGreaterThan(0);
  });
});

describe('referral quality score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/quality-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.qualityScore).toBe(0);
  });

  it('calculates referral quality', async () => {
    const referral = await ctx.prisma.referral.create({
      data: { userId: ctx.user.id, code: 'REFQ1', status: 'active' },
    });
    await ctx.prisma.referralSignup.create({
      data: { referralId: referral.id, referredUserId: 'user-a', status: 'rewarded' },
    });
    await ctx.prisma.referralSignup.create({
      data: { referralId: referral.id, referredUserId: 'user-b', status: 'pending' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/quality-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.qualityScore).toBeGreaterThan(0);
    expect(body.totalSignups).toBe(2);
    expect(body.rewardedSignups).toBe(1);
    expect(body.breakdown).toBeDefined();
  });
});

describe('savings velocity trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/velocity-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.avgDailySavings).toBe('0');
  });

  it('calculates savings velocity', async () => {
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Vacation', targetAmount: BigInt(100000),
        currentAmount: BigInt(25000), currency: 'USD', status: 'active',
      },
    });
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Car', targetAmount: BigInt(500000),
        currentAmount: BigInt(50000), currency: 'USD', status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/velocity-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(2);
    expect(body.goalVelocities.length).toBe(2);
    expect(body.trend).toBeDefined();
  });
});

describe('transfer load distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/load-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.peakDay).toBeNull();
  });

  it('analyzes transfer load', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, amount: BigInt(5000),
        currency: 'USD', frequency: 'weekly', status: 'active',
        recipientId: 'rec-1',
      },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, amount: BigInt(10000),
        currency: 'USD', frequency: 'monthly', status: 'active',
        recipientId: 'rec-2',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/load-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(2);
    expect(Object.keys(body.byFrequency).length).toBeGreaterThan(0);
    expect(body.loadBalance).toBeGreaterThan(0);
  });
});
