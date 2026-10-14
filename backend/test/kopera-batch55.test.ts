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
    payload: { email: 'b55@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b55@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('points reward velocity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no history', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/reward-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.trend).toBe('none');
    expect(body.byWeek).toBeInstanceOf(Array);
  });

  it('tracks earn/redeem velocity over time', async () => {
    const pts = await ctx.prisma.koperaPoints.create({
      data: { userId: ctx.user.id, balance: 500, lifetimeEarned: 800, tier: 'BRONZE' },
    });
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await ctx.prisma.pointsHistory.create({
        data: {
          pointsId: pts.id, amount: 200, type: 'EARN',
          reason: 'purchase', createdAt: new Date(now + i * 86400000),
        },
      });
    }
    await ctx.prisma.pointsHistory.create({
      data: {
        pointsId: pts.id, amount: 100, type: 'REDEEM',
        reason: 'reward', createdAt: new Date(now + 5 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/reward-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(5);
    expect(body.earnVelocity).toBeGreaterThan(0);
    expect(body.redeemVelocity).toBeGreaterThan(0);
    expect(body.netVelocityPerDay).toBeGreaterThan(0);
    expect(body.byWeek.length).toBeGreaterThan(0);
  });
});

describe('referrals virality score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zero with no referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/virality-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.viralityScore).toBe(0);
    expect(body.viralityLevel).toBe('none');
  });

  it('computes virality metrics with signups', async () => {
    const referral = await ctx.prisma.referral.create({
      data: {
        referrerId: ctx.user.id, code: 'VIRAL01',
        status: 'active', signupCount: 3, rewardedCount: 2, totalPointsEarned: 1000,
      },
    });
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.referralSignup.create({
        data: {
          referralId: referral.id, referredUserId: `referred-${i}`,
          createdAt: new Date(now + i * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/virality-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.signupVelocity).toBeGreaterThan(0);
    expect(body.rewardConversionRate).toBeGreaterThan(0);
    expect(body.viralityScore).toBeGreaterThan(0);
    expect(body.signupsByMonth.length).toBeGreaterThan(0);
  });
});

describe('savings goals deadline risk', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_deadlines with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/deadline-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toBe('no_deadlines');
    expect(body.atRisk).toBeInstanceOf(Array);
  });

  it('identifies at-risk goals near deadline', async () => {
    const now = Date.now();
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Vacation', targetAmount: BigInt(100000),
        currentAmount: BigInt(10000), currency: 'USD', status: 'active',
        deadline: new Date(now + 5 * 86400000),
        createdAt: new Date(now - 60 * 86400000),
      },
    });
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Car', targetAmount: BigInt(50000),
        currentAmount: BigInt(45000), currency: 'USD', status: 'active',
        deadline: new Date(now + 90 * 86400000),
        createdAt: new Date(now - 30 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/deadline-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.goalsWithDeadline).toBe(2);
    expect(body.atRisk.length).toBeGreaterThanOrEqual(1);
    const vacation = body.atRisk.find((r: any) => r.name === 'Vacation');
    expect(vacation).toBeDefined();
    expect(vacation.riskLevel).toBe('high');
  });
});

describe('scheduled transfers execution success rate', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/execution-success-rate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.successRate).toBe(0);
    expect(body.byFrequency).toBeInstanceOf(Array);
  });

  it('computes success rate from execution counts', async () => {
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, toUserId: 'recv1', currency: 'USD',
        amount: BigInt(5000), frequency: 'weekly', status: 'active',
        executionCount: 5, nextExecutionDate: new Date(),
      },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, toUserId: 'recv2', currency: 'USD',
        amount: BigInt(3000), frequency: 'monthly', status: 'active',
        executionCount: 0, nextExecutionDate: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/execution-success-rate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(2);
    expect(body.totalExecutions).toBe(5);
    expect(body.successRate).toBe(50);
    expect(body.byFrequency.length).toBe(2);
    expect(body.mostReliable).toBeDefined();
  });
});

describe('subscriptions cancellation risk', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no active subs', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/cancellation-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActive).toBe(0);
    expect(body.atRisk).toBeInstanceOf(Array);
    expect(body.overallRiskScore).toBe(0);
  });

  it('identifies at-risk subscriptions', async () => {
    const now = Date.now();
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'Premium', amount: BigInt(50000),
        currency: 'USD', interval: 'monthly', intervalCount: 1,
        status: 'active',
        currentPeriodStart: new Date(now - 25 * 86400000),
        currentPeriodEnd: new Date(now + 5 * 86400000),
        createdAt: new Date(now - 10 * 86400000),
      },
    });
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'Basic', amount: BigInt(1000),
        currency: 'USD', interval: 'yearly', intervalCount: 1,
        status: 'active',
        currentPeriodStart: new Date(now - 180 * 86400000),
        currentPeriodEnd: new Date(now + 185 * 86400000),
        createdAt: new Date(now - 365 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/cancellation-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActive).toBe(2);
    expect(body.atRisk.length).toBeGreaterThanOrEqual(1);
    const premium = body.atRisk.find((r: any) => r.planName === 'Premium');
    expect(premium).toBeDefined();
    expect(premium.reasons.length).toBeGreaterThan(0);
  });
});
