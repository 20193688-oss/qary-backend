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
    payload: { email: 'b75@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b75@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment-links revenue concentration', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/revenue-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.totalRevenue).toBe('0');
    expect(body.diversificationLevel).toBe('no_data');
    expect(body.topContributors).toEqual([]);
  });

  it('calculates concentration with seeded links', async () => {
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, code: 'PL1', amount: BigInt(50000), currency: 'USD', status: 'active', description: 'Large link', timesUsed: 3 },
    });
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, code: 'PL2', amount: BigInt(1000), currency: 'USD', status: 'active', description: 'Small link', timesUsed: 1 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/revenue-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(2);
    expect(Number(body.totalRevenue)).toBeGreaterThan(0);
    expect(body.concentrationScore).toBeGreaterThan(0);
    expect(body.topContributors.length).toBeLessThanOrEqual(5);
    expect(body.diversificationLevel).toBeDefined();
  });
});

describe('points redemption efficiency', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no points data', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/redemption-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEarned).toBe(0);
    expect(body.totalRedeemed).toBe(0);
    expect(body.efficiencyScore).toBeDefined();
    expect(body.efficiencyLevel).toBeDefined();
  });

  it('analyzes efficiency with seeded history', async () => {
    await ctx.prisma.koperaPoints.create({
      data: { userId: ctx.user.id, balance: 500, tier: 'silver', lifetimeEarned: 1000 },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, amount: 1000, type: 'EARN', reason: 'bonus' },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, amount: 500, type: 'REDEEM', reason: 'reward' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/redemption-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEarned).toBe(1000);
    expect(body.totalRedeemed).toBe(500);
    expect(body.redemptionRate).toBe(50);
    expect(body.currentBalance).toBe(500);
    expect(body.efficiencyLevel).toBeDefined();
  });
});

describe('referral revenue attribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no-referral defaults', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/revenue-attribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.totalSignups).toBe(0);
    expect(body.attributionLevel).toBe('none');
  });

  it('calculates attribution with signups', async () => {
    const ref = await ctx.prisma.referral.create({
      data: { userId: ctx.user.id, referrerId: ctx.user.id, code: 'REF75', status: 'active', rewardAmount: BigInt(500) },
    });
    await ctx.prisma.referralSignup.create({
      data: { referralId: ref.id, referredUserId: 'u-referred-1', status: 'active' },
    });
    await ctx.prisma.referralSignup.create({
      data: { referralId: ref.id, referredUserId: 'u-referred-2', status: 'converted' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/revenue-attribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.totalSignups).toBe(2);
    expect(body.activeSignups).toBe(2);
    expect(Number(body.estimatedRevenue)).toBeGreaterThan(0);
    expect(body.attributionLevel).toBe('low');
  });
});

describe('savings goal prioritization', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty prioritization', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/prioritization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.prioritizedGoals).toEqual([]);
  });

  it('prioritizes goals by urgency', async () => {
    const soon = new Date(Date.now() + 15 * 86400000).toISOString();
    await ctx.prisma.savingsGoal.create({
      data: { userId: ctx.user.id, name: 'Urgent Goal', targetAmount: BigInt(100000), currentAmount: BigInt(5000), currency: 'USD', status: 'active', targetDate: new Date(soon) },
    });
    await ctx.prisma.savingsGoal.create({
      data: { userId: ctx.user.id, name: 'Relaxed Goal', targetAmount: BigInt(50000), currentAmount: BigInt(40000), currency: 'USD', status: 'active' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/prioritization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(2);
    expect(body.prioritizedGoals.length).toBe(2);
    expect(body.prioritizedGoals[0].urgencyScore).toBeGreaterThanOrEqual(body.prioritizedGoals[1].urgencyScore);
    expect(body.prioritizedGoals[0].name).toBe('Urgent Goal');
  });
});

describe('scheduled transfer reliability index', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/reliability-index',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.reliabilityIndex).toBe(100);
    expect(body.reliabilityLevel).toBe('no_data');
  });

  it('computes reliability with mixed statuses', async () => {
    const base = { userId: ctx.user.id, toUserId: 'u-recv', currency: 'USD', amount: BigInt(10000), frequency: 'monthly' };
    await ctx.prisma.scheduledTransfer.create({ data: { ...base, status: 'completed' } });
    await ctx.prisma.scheduledTransfer.create({ data: { ...base, status: 'completed' } });
    await ctx.prisma.scheduledTransfer.create({ data: { ...base, status: 'failed' } });
    await ctx.prisma.scheduledTransfer.create({ data: { ...base, status: 'cancelled' } });
    await ctx.prisma.scheduledTransfer.create({ data: { ...base, status: 'active' } });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/reliability-index',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(5);
    expect(body.successRate).toBeGreaterThan(0);
    expect(body.failureRate).toBeGreaterThan(0);
    expect(body.reliabilityLevel).toBeDefined();
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});
