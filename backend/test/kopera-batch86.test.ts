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
    payload: { email: 'b86@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b86@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('points accumulation trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no points history', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/accumulation-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.trendLevel).toBe('no_data');
  });

  it('analyzes accumulation trend with history', async () => {
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, type: 'earn', points: 500, description: 'Welcome bonus' },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, type: 'redeem', points: 200, description: 'Redeemed' },
    });
    await ctx.prisma.pointsHistory.create({
      data: { userId: ctx.user.id, type: 'earn', points: 300, description: 'Referral' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/accumulation-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(3);
    expect(body.activeMonths).toBeGreaterThanOrEqual(1);
    expect(body.monthlyBreakdown.length).toBeGreaterThanOrEqual(1);
    expect(body.trendLevel).toBeDefined();
  });
});

describe('referral conversion pipeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no referrals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/conversion-pipeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalReferrals).toBe(0);
    expect(body.pipelineLevel).toBe('no_data');
  });

  it('analyzes pipeline with referrals', async () => {
    await ctx.prisma.referral.create({
      data: { userId: ctx.user.id, code: 'REF86A', status: 'active', signupCount: 3, rewardedCount: 1 },
    });
    await ctx.prisma.referral.create({
      data: { userId: ctx.user.id, code: 'REF86B', status: 'active', signupCount: 0, rewardedCount: 0 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/conversion-pipeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalReferrals).toBe(2);
    expect(body.stages.invited).toBe(2);
    expect(body.stages.signedUp).toBe(3);
    expect(body.pipelineLevel).toBeDefined();
  });
});

describe('savings goal momentum tracker', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/momentum-tracker',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.momentumLevel).toBe('no_data');
  });

  it('tracks momentum with active goals', async () => {
    await ctx.prisma.savingsGoal.create({
      data: { userId: ctx.user.id, name: 'Vacation', targetAmount: BigInt(100000), currentAmount: BigInt(50000), currency: 'USD', status: 'active' },
    });
    await ctx.prisma.savingsGoal.create({
      data: { userId: ctx.user.id, name: 'Emergency', targetAmount: BigInt(200000), currentAmount: BigInt(1000), currency: 'USD', status: 'active' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/momentum-tracker',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(2);
    expect(body.momentumScore).toBeGreaterThan(0);
    expect(body.breakdown).toBeDefined();
    expect(body.momentumLevel).toBeDefined();
  });
});

describe('transfer failure analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/failure-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.failureLevel).toBe('no_data');
  });

  it('analyzes failures with mixed statuses', async () => {
    await ctx.prisma.scheduledTransfer.create({
      data: { userId: ctx.user.id, walletId: 'w1', beneficiaryId: 'b1', amount: BigInt(5000), currency: 'USD', frequency: 'monthly', nextExecutionDate: new Date(), status: 'completed' },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: { userId: ctx.user.id, walletId: 'w1', beneficiaryId: 'b1', amount: BigInt(3000), currency: 'USD', frequency: 'weekly', nextExecutionDate: new Date(), status: 'failed' },
    });
    await ctx.prisma.scheduledTransfer.create({
      data: { userId: ctx.user.id, walletId: 'w1', beneficiaryId: 'b1', amount: BigInt(2000), currency: 'USD', frequency: 'monthly', nextExecutionDate: new Date(), status: 'active' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/failure-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(3);
    expect(body.breakdown.completed).toBe(1);
    expect(body.breakdown.failed).toBe(1);
    expect(body.failureRate).toBeGreaterThan(0);
    expect(body.failureLevel).toBeDefined();
  });
});

describe('subscription renewal forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/renewal-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.forecastLevel).toBe('no_data');
  });

  it('forecasts renewals with mixed statuses', async () => {
    await ctx.prisma.subscription.create({
      data: { userId: ctx.user.id, planId: 'plan1', amount: BigInt(9900), currency: 'USD', interval: 'monthly', status: 'active', nextBillingDate: new Date(Date.now() + 15 * 86400000) },
    });
    await ctx.prisma.subscription.create({
      data: { userId: ctx.user.id, planId: 'plan2', amount: BigInt(4900), currency: 'USD', interval: 'monthly', status: 'past_due', nextBillingDate: new Date(Date.now() - 5 * 86400000) },
    });
    await ctx.prisma.subscription.create({
      data: { userId: ctx.user.id, planId: 'plan3', amount: BigInt(1900), currency: 'USD', interval: 'monthly', status: 'cancelled' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/renewal-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(3);
    expect(body.breakdown.renewable).toBe(1);
    expect(body.breakdown.atRisk).toBe(1);
    expect(body.breakdown.expired).toBe(1);
    expect(body.projectedMonthlyRevenue).toBeDefined();
    expect(body.forecastLevel).toBeDefined();
  });
});
