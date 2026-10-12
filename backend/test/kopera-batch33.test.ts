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
    payload: { email: 'b33@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b33@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('user profile account overview', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns overview for new account', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/account-overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountType).toBe('PERSONAL');
    expect(typeof body.accountAgeDays).toBe('number');
    expect(typeof body.completionPercent).toBe('number');
    expect(body.securityFeatures.emailVerified).toBe(true);
    expect(body.securityScore).toBeGreaterThanOrEqual(1);
    expect(body.missingFields).toBeInstanceOf(Array);
  });

  it('increases completion after updating profile', async () => {
    const before = await ctx.app.inject({
      method: 'GET', url: '/api/profile/account-overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    await ctx.app.inject({
      method: 'PATCH', url: '/api/profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Test User', phone: '+1234567890', country: 'US' },
    });

    const after = await ctx.app.inject({
      method: 'GET', url: '/api/profile/account-overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(after.json().completionPercent).toBeGreaterThan(before.json().completionPercent);
  });
});

describe('wallet cash flow report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns cash flow after transactions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/cash-flow-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTransactions).toBeGreaterThanOrEqual(1);
    expect(res.json().byCurrency.USD).toBeDefined();
    expect(typeof res.json().byCurrency.USD.inflow).toBe('string');
    expect(typeof res.json().byType).toBe('object');
  });

  it('returns empty report with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/cash-flow-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTransactions).toBe(0);
  });
});

describe('kyc compliance summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns summary after starting KYC', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'PASSPORT', documentNumber: 'AB123456',
        documentCountry: 'US', firstName: 'Test', lastName: 'User',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/compliance-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kycStarted).toBe(true);
    expect(res.json().status).toBe('IN_REVIEW');
    expect(typeof res.json().completionPercent).toBe('number');
    expect(res.json().complianceReady).toBe(false);
  });

  it('returns not-started summary without KYC', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/compliance-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kycStarted).toBe(false);
    expect(res.json().completionPercent).toBe(0);
  });
});

describe('points tier progress', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns tier progress after earning points', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 500, reason: 'test' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/tier-progress',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentTier).toBe('BRONZE');
    expect(res.json().lifetimeEarned).toBe(500);
    expect(res.json().nextTier).toBe('SILVER');
    expect(res.json().pointsToNextTier).toBe(500);
    expect(res.json().earningVelocity.last30Days).toBe(500);
    expect(typeof res.json().currentMultiplier).toBe('number');
  });

  it('returns base progress with no points', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/tier-progress',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentTier).toBe('BRONZE');
    expect(res.json().lifetimeEarned).toBe(0);
    expect(res.json().nextTier).toBe('SILVER');
  });
});

describe('scheduled transfer reliability report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  let recipientId: string;
  beforeEach(async () => {
    ctx = await bootstrap();
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'recipient33@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'recipient33@kopera.io', code: reg2.json().debugOtp },
    });
    recipientId = v2.json().user.id;
  });

  it('returns reliability after creating transfers', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: recipientId, currency: 'USD', amount: 50, frequency: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/reliability-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalScheduled).toBe(1);
    expect(res.json().activeCount).toBe(1);
    expect(typeof res.json().completionRate).toBe('number');
    expect(res.json().topRecipients).toHaveLength(1);
  });

  it('returns empty report with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/reliability-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalScheduled).toBe(0);
    expect(res.json().completionRate).toBe(0);
  });
});
