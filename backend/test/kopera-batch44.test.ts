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
    payload: { email: 'b44@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b44@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('referral network growth', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty growth with no referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/network-growth',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(false);
    expect(body.totalSignups).toBe(0);
    expect(body.growthByMonth).toBeInstanceOf(Array);
    expect(body.topMonth).toBeNull();
  });

  it('analyzes growth after referral signups', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const referral = await ctx.prisma.referral.findFirst({
      where: { referrerId: ctx.user.id },
    });

    await ctx.prisma.referralSignup.create({
      data: { referralId: referral!.id, referredUserId: 'user-ref-1', status: 'rewarded' },
    });
    await ctx.prisma.referralSignup.create({
      data: { referralId: referral!.id, referredUserId: 'user-ref-2', status: 'pending' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/network-growth',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasReferralCode).toBe(true);
    expect(body.totalSignups).toBe(2);
    expect(body.rewardedSignups).toBe(1);
    expect(body.pendingSignups).toBe(1);
    expect(body.conversionRate).toBe(50);
    expect(body.growthByMonth.length).toBeGreaterThan(0);
    expect(body.avgSignupsPerMonth).toBeGreaterThan(0);
    expect(body.topMonth).toBeDefined();
  });
});

describe('transaction-limits spending velocity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty velocity with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/spending-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.velocities).toBeInstanceOf(Array);
    expect(body.fastestBurning).toBeNull();
    expect(body.avgUtilization).toBe(0);
  });

  it('calculates velocity after setting limits with usage', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 1000 },
    });

    await ctx.prisma.transactionLimit.updateMany({
      where: { userId: ctx.user.id },
      data: { currentUsage: BigInt(30000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/spending-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(1);
    expect(body.velocities.length).toBe(1);
    expect(body.velocities[0].currency).toBe('USD');
    expect(body.velocities[0].utilizationPercent).toBeGreaterThan(0);
    expect(body.fastestBurning).toBeDefined();
    expect(body.avgUtilization).toBeGreaterThan(0);
  });
});

describe('wallet liquidity analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty analysis with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/liquidity-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(0);
    expect(body.totalAvailableLiquidity).toBe('0');
    expect(body.liquidityScore).toBe('none');
  });

  it('analyzes liquidity after creating wallets', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 200 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/liquidity-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(2);
    expect(Number(body.totalAvailableLiquidity)).toBeGreaterThan(0);
    expect(body.byCurrency.length).toBe(2);
    expect(body.liquidityScore).toBeDefined();
    expect(body.liquidityRatio).toBeGreaterThan(0);
  });
});

describe('points engagement score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns baseline engagement with no activity', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/engagement-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engagementScore).toBeDefined();
    expect(body.engagementLevel).toBeDefined();
    expect(body.components).toBeDefined();
    expect(body.recentActivity).toBeDefined();
    expect(body.recentActivity.earnsLast30Days).toBe(0);
  });

  it('calculates engagement after earning points', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 100, reason: 'signup_bonus' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 50, reason: 'referral' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/engagement-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engagementScore).toBeGreaterThan(0);
    expect(body.recentActivity.earnsLast30Days).toBe(2);
    expect(body.recentActivity.pointsEarnedLast30Days).toBe(150);
    expect(body.balance).toBe(150);
    expect(body.lifetimeEarned).toBe(150);
    expect(body.components.activityFrequency).toBeGreaterThan(0);
  });
});

describe('scheduled-transfers recipient analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty analysis with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/recipient-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.uniqueRecipients).toBe(0);
    expect(body.recipients).toBeInstanceOf(Array);
    expect(body.topRecipient).toBeNull();
    expect(body.concentrationLevel).toBe('none');
  });

  it('analyzes recipients after creating transfers', async () => {
    const recipient = await ctx.prisma.user.create({
      data: { email: 'recipient-b44@kopera.io' },
    });
    const recipient2 = await ctx.prisma.user.create({
      data: { email: 'recipient2-b44@kopera.io' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: recipient.id, currency: 'USD', amount: 100, frequency: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: recipient2.id, currency: 'PEN', amount: 50, frequency: 'weekly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/recipient-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(2);
    expect(body.uniqueRecipients).toBe(2);
    expect(body.recipients.length).toBe(2);
    expect(body.topRecipient).toBeDefined();
    expect(body.topRecipient.toUserId).toBeDefined();
    expect(body.concentrationLevel).toBeDefined();
  });
});
