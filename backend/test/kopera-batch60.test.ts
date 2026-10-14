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
    payload: { email: 'b60@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b60@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment links expiration impact analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/expiration-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.expirationRate).toBe(0);
    expect(body.lostRevenue).toBe('0');
  });

  it('analyzes expiration impact across links', async () => {
    const now = Date.now();
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, amount: BigInt(5000), currency: 'USD',
        code: 'EXP1', status: 'expired',
        expiresAt: new Date(now - 86400000),
        createdAt: new Date(now - 7 * 86400000),
      },
    });
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, amount: BigInt(3000), currency: 'USD',
        code: 'USED1', status: 'active',
        usedAt: new Date(now - 2 * 86400000),
        createdAt: new Date(now - 5 * 86400000),
      },
    });
    await ctx.prisma.paymentLink.create({
      data: {
        userId: ctx.user.id, amount: BigInt(2000), currency: 'USD',
        code: 'ACT1', status: 'active',
        expiresAt: new Date(now + 7 * 86400000),
        createdAt: new Date(now - 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/expiration-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(3);
    expect(body.expired).toBe(1);
    expect(body.used).toBe(1);
    expect(body.expirationRate).toBeGreaterThan(0);
    expect(Number(body.lostRevenue)).toBeGreaterThan(0);
  });
});

describe('points economy health', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns inactive with no history', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/economy-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEarned).toBe(0);
    expect(body.healthStatus).toBe('inactive');
  });

  it('analyzes points economy with transactions', async () => {
    const pts = await ctx.prisma.koperaPoints.create({
      data: { userId: ctx.user.id, balance: 500, lifetimeEarned: 1000, tier: 'SILVER' },
    });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.pointsHistory.create({
        data: {
          pointsId: pts.id, amount: 200, type: 'EARN',
          reason: `earn-${i}`, createdAt: new Date(now - i * 86400000),
        },
      });
    }
    await ctx.prisma.pointsHistory.create({
      data: {
        pointsId: pts.id, amount: -500, type: 'REDEEM',
        reason: 'redeem-1', createdAt: new Date(now - 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/economy-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEarned).toBe(1000);
    expect(body.totalRedeemed).toBe(500);
    expect(body.utilizationRate).toBe(50);
    expect(body.healthStatus).toBe('healthy');
    expect(body.recent30Days).toBeDefined();
  });
});

describe('referral retention analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/retention-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.totalSignups).toBe(0);
  });

  it('analyzes referral retention patterns', async () => {
    const referral = await ctx.prisma.referral.create({
      data: { referrerId: ctx.user.id, code: 'RETAIN1', status: 'active' },
    });
    const now = Date.now();
    await ctx.prisma.referralSignup.create({
      data: {
        referralId: referral.id, referredUserId: 'user-r1',
        createdAt: new Date(now - 30 * 86400000),
        rewardedAt: new Date(now - 25 * 86400000),
      },
    });
    await ctx.prisma.referralSignup.create({
      data: {
        referralId: referral.id, referredUserId: 'user-r2',
        createdAt: new Date(now - 20 * 86400000),
        rewardedAt: new Date(now - 10 * 86400000),
      },
    });
    await ctx.prisma.referralSignup.create({
      data: {
        referralId: referral.id, referredUserId: 'user-r3',
        createdAt: new Date(now - 10 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/retention-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.totalSignups).toBe(3);
    expect(body.rewardedCount).toBe(2);
    expect(body.retentionRate).toBeGreaterThan(0);
    expect(body.avgDaysToReward).toBeGreaterThan(0);
  });
});

describe('savings goals consistency score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/consistency-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.overallScore).toBe(0);
    expect(body.consistencyLevel).toBe('none');
  });

  it('analyzes contribution consistency', async () => {
    const goal = await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Vacation',
        targetAmount: BigInt(100000), currentAmount: BigInt(30000),
        currency: 'USD', status: 'active',
        createdAt: new Date(Date.now() - 90 * 86400000),
      },
    });
    for (let i = 0; i < 4; i++) {
      await ctx.prisma.savingsContribution.create({
        data: {
          savingsGoalId: goal.id, amount: BigInt(7500),
          createdAt: new Date(Date.now() - (i * 30 + 5) * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/consistency-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(1);
    expect(body.overallScore).toBeGreaterThan(0);
    expect(body.consistencyLevel).toBeDefined();
    expect(body.goals.length).toBe(1);
    expect(body.goals[0].totalContributions).toBe(4);
  });
});

describe('scheduled transfers schedule conflict analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no schedules', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/schedule-conflicts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveSchedules).toBe(0);
    expect(body.concentrationRisk).toBe('none');
    expect(body.peakDay).toBeNull();
  });

  it('detects scheduling conflicts', async () => {
    const sameDay = new Date(2025, 6, 15);
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, recipientId: 'rec-1',
        amount: BigInt(5000), currency: 'USD',
        frequency: 'monthly', status: 'active',
        nextExecutionDate: sameDay,
      },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, recipientId: 'rec-2',
        amount: BigInt(3000), currency: 'USD',
        frequency: 'monthly', status: 'active',
        nextExecutionDate: sameDay,
      },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, recipientId: 'rec-3',
        amount: BigInt(2000), currency: 'USD',
        frequency: 'weekly', status: 'active',
        nextExecutionDate: new Date(2025, 6, 20),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/schedule-conflicts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveSchedules).toBe(3);
    expect(body.conflictDays.length).toBeGreaterThan(0);
    expect(body.peakDay).toBe(15);
    expect(body.concentrationRisk).not.toBe('none');
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});
