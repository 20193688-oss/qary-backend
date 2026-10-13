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
    payload: { email: 'b50@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b50@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('points decay risk', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns low risk with no history', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/decay-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentTier).toBe('BRONZE');
    expect(body.riskLevel).toBe('low');
    expect(body.decayRate).toBe(0);
    expect(body.projectedDaysUntilTierLoss).toBeNull();
    expect(body.activity.last7Days.transactions).toBe(0);
  });

  it('computes activity windows from earning history', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 200, reason: 'purchase' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 300, reason: 'bonus' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/decay-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activity.last7Days.transactions).toBe(2);
    expect(body.activity.last7Days.pointsEarned).toBe(500);
    expect(body.activity.last30Days.pointsEarned).toBe(500);
    expect(body.lifetimeEarned).toBe(500);
    expect(body.balance).toBe(500);
  });
});

describe('referral effectiveness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.totalSignups).toBe(0);
    expect(body.effectivenessScore).toBe(0);
    expect(body.weeklyBreakdown).toBeInstanceOf(Array);
  });

  it('measures effectiveness after referral activity', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const referral = await ctx.prisma.referral.findFirst({
      where: { referrerId: ctx.user.id },
    });

    await ctx.prisma.referralSignup.create({
      data: {
        referralId: referral!.id,
        referredUserId: 'referred-user-1',
        status: 'completed',
        rewardedAt: new Date(),
      },
    });
    await ctx.prisma.referral.update({
      where: { id: referral!.id },
      data: { signupCount: 1, rewardedCount: 1, totalPointsEarned: 500 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.totalSignups).toBe(1);
    expect(body.totalRewarded).toBe(1);
    expect(body.conversionRate).toBe(100);
    expect(body.effectivenessScore).toBeGreaterThan(0);
    expect(body.totalPointsEarned).toBe(500);
  });
});

describe('savings goals milestone analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/milestone-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.milestonesSummary.reached25).toBe(0);
    expect(body.goals).toBeInstanceOf(Array);
    expect(body.avgMomentum).toBe(0);
  });

  it('tracks milestones for goals at various progress levels', async () => {
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Half done', targetAmount: BigInt(10000),
        currentAmount: BigInt(5000), currency: 'USD', status: 'active',
      },
    });
    await ctx.prisma.savingsGoal.create({
      data: {
        userId: ctx.user.id, name: 'Complete', targetAmount: BigInt(5000),
        currentAmount: BigInt(5000), currency: 'USD', status: 'completed',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/milestone-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(2);
    expect(body.milestonesSummary.reached25).toBe(2);
    expect(body.milestonesSummary.reached50).toBe(2);
    expect(body.milestonesSummary.reached100).toBe(1);
    expect(body.goals.length).toBe(2);
    const halfDone = body.goals.find((g: any) => g.name === 'Half done');
    expect(halfDone.passedMilestones).toContain(25);
    expect(halfDone.passedMilestones).toContain(50);
    expect(halfDone.passedMilestones).not.toContain(75);
    expect(halfDone.nextMilestone).toBe(75);
  });
});

describe('scheduled transfers frequency optimization', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/frequency-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.consolidationOpportunities).toBeInstanceOf(Array);
    expect(body.inactiveButScheduled).toBeInstanceOf(Array);
    expect(body.suggestions).toBeInstanceOf(Array);
  });

  it('identifies consolidation opportunities', async () => {
    const recipient = await ctx.prisma.user.create({
      data: { email: 'recip-freq@test.io' },
    });

    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, toUserId: recipient.id, currency: 'USD',
        amount: BigInt(5000), frequency: 'weekly', status: 'active',
        description: 'Transfer 1', nextExecutionDate: new Date(), executionCount: 1,
      },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id, toUserId: recipient.id, currency: 'USD',
        amount: BigInt(3000), frequency: 'monthly', status: 'active',
        description: 'Transfer 2', nextExecutionDate: new Date(), executionCount: 2,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/frequency-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(2);
    expect(body.activeTransfers).toBe(2);
    expect(body.consolidationOpportunities.length).toBe(1);
    expect(body.consolidationOpportunities[0].transferCount).toBe(2);
    expect(body.suggestions.length).toBeGreaterThan(0);
  });
});

describe('subscriptions spending trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zeros with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/spending-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.currentMonthlyCost).toBe('0');
    expect(body.monthlyTrend).toBeInstanceOf(Array);
    expect(body.projectedNextMonth).toBe('0');
    expect(body.monthOverMonthChange).toBe(0);
  });

  it('computes spending trend from active subscriptions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro Plan', amount: 29.99, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Storage', amount: 9.99, currency: 'USD', interval: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/spending-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(2);
    expect(body.activeSubscriptions).toBe(2);
    expect(Number(body.currentMonthlyCost)).toBeGreaterThan(0);
    expect(body.monthlyTrend.length).toBe(6);
    expect(body.projectedNextMonth).toBe(body.currentMonthlyCost);
  });
});
