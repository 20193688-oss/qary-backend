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
    payload: { email: 'b80@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b80@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('points expiry risk', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no points', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/expiry-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentBalance).toBe(0);
    expect(body.riskLevel).toBe('no_data');
  });

  it('assesses expiry risk with points data', async () => {
    await ctx.prisma.koperaPoints.create({
      data: { userId: ctx.user.id, balance: 500 },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, points: 500, type: 'EARN', description: 'signup bonus' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/expiry-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentBalance).toBe(500);
    expect(body.expiryScore).toBeGreaterThanOrEqual(0);
    expect(body.riskLevel).toBeDefined();
  });
});

describe('referral network health', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no referral', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/network-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.healthLevel).toBe('no_data');
  });

  it('evaluates network health with signups', async () => {
    const ref = await ctx.prisma.referral.create({
      data: { userId: ctx.user.id, referrerId: ctx.user.id, code: 'REF80', status: 'active', rewardAmount: BigInt(500) },
    });
    await ctx.prisma.referralSignup.create({
      data: { referralId: ref.id, userId: 'user-a', status: 'active' },
    });
    await ctx.prisma.referralSignup.create({
      data: { referralId: ref.id, userId: 'user-b', status: 'pending' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/network-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.totalSignups).toBe(2);
    expect(body.activeSignups).toBe(1);
    expect(body.healthScore).toBeGreaterThan(0);
  });
});

describe('savings goal risk assessment', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.riskLevel).toBe('no_data');
  });

  it('assesses risk with goals', async () => {
    await ctx.prisma.savingsGoal.create({
      data: { userId: ctx.user.id, name: 'Vacation', targetAmount: BigInt(100000), currentAmount: BigInt(80000), currency: 'USD', targetDate: new Date(Date.now() + 90 * 86400000) },
    });
    await ctx.prisma.savingsGoal.create({
      data: { userId: ctx.user.id, name: 'Car', targetAmount: BigInt(500000), currentAmount: BigInt(50000), currency: 'USD', targetDate: new Date(Date.now() + 15 * 86400000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(2);
    expect(body.atRiskGoals).toBeGreaterThan(0);
    expect(body.goals.length).toBe(2);
    expect(body.riskLevel).toBeDefined();
  });
});

describe('transfer schedule optimization', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/schedule-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.optimizationLevel).toBe('no_data');
  });

  it('analyzes schedule with transfers', async () => {
    await ctx.prisma.scheduledTransfer.create({
      data: { userId: ctx.user.id, recipientId: 'rec1', amount: BigInt(5000), currency: 'USD', frequency: 'weekly', status: 'active', nextExecutionDate: new Date() },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: { userId: ctx.user.id, recipientId: 'rec2', amount: BigInt(10000), currency: 'USD', frequency: 'monthly', status: 'active', nextExecutionDate: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/schedule-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(2);
    expect(body.activeTransfers).toBe(2);
    expect(body.optimizationScore).toBeGreaterThan(0);
    expect(body.optimizationLevel).toBeDefined();
  });
});

describe('subscription value score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/value-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.valueLevel).toBe('no_data');
  });

  it('scores value with subscriptions', async () => {
    await ctx.prisma.subscription.create({
      data: { userId: ctx.user.id, planName: 'Pro', amount: BigInt(2000), currency: 'USD', interval: 'monthly', status: 'ACTIVE', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
    await ctx.prisma.subscription.create({
      data: { userId: ctx.user.id, planName: 'Basic', amount: BigInt(500), currency: 'USD', interval: 'monthly', status: 'CANCELLED', currentPeriodStart: new Date(), currentPeriodEnd: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/value-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(2);
    expect(body.activeSubscriptions).toBe(1);
    expect(body.valueScore).toBeGreaterThan(0);
    expect(body.valueLevel).toBeDefined();
  });
});
