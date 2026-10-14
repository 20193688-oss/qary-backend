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
    payload: { email: 'b56@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b56@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('tokenized cards token lifecycle analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/token-lifecycle-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.lifecycleHealth).toBe('none');
    expect(body.expiringWithin90Days).toBeInstanceOf(Array);
  });

  it('analyzes card lifecycle with mixed statuses', async () => {
    const now = new Date();
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, last4: '1111', network: 'VISA',
        expiryMonth: now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2,
        expiryYear: now.getMonth() + 2 > 12 ? now.getFullYear() + 1 : now.getFullYear(),
        vaultToken: 'vt1',
        createdAt: new Date(Date.now() - 90 * 86400000),
      },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, last4: '2222', network: 'MASTERCARD',
        expiryMonth: 1, expiryYear: 2020,
        vaultToken: 'vt2',
        createdAt: new Date(Date.now() - 365 * 86400000),
      },
    });
    await ctx.prisma.tokenizedCard.create({
      data: {
        userId: ctx.user.id, last4: '3333', network: 'VISA',
        expiryMonth: 12, expiryYear: 2030,
        vaultToken: 'vt3', frozen: true,
        createdAt: new Date(Date.now() - 30 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/token-lifecycle-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(3);
    expect(body.byStatus.active).toBe(1);
    expect(body.byStatus.expired).toBe(1);
    expect(body.byStatus.frozen).toBe(1);
    expect(body.avgAgeDays).toBeGreaterThan(0);
    expect(body.turnoverRate).toBeGreaterThan(0);
    expect(body.lifecycleHealth).toBeDefined();
  });
});

describe('transaction limits exhaustion forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/exhaustion-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.overallRisk).toBe('none');
    expect(body.forecasts).toBeInstanceOf(Array);
  });

  it('forecasts exhaustion for limits with usage', async () => {
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'USD', limitType: 'daily',
        maxAmount: BigInt(100000), currentUsage: BigInt(90000),
        periodStart: new Date(Date.now() - 12 * 3600000),
      },
    });
    await ctx.prisma.transactionLimit.create({
      data: {
        userId: ctx.user.id, currency: 'USD', limitType: 'monthly',
        maxAmount: BigInt(5000000), currentUsage: BigInt(500000),
        periodStart: new Date(Date.now() - 5 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/exhaustion-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.forecasts.length).toBe(2);
    expect(body.criticalCount + body.warningCount + body.safeCount).toBe(2);
    const dailyForecast = body.forecasts.find((f: any) => f.limitType === 'daily');
    expect(dailyForecast).toBeDefined();
    expect(dailyForecast.utilizationPercent).toBeGreaterThan(0);
    expect(body.overallRisk).not.toBe('none');
  });
});

describe('transactions amount distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/amount-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.buckets).toBeInstanceOf(Array);
  });

  it('computes distribution buckets and percentiles', async () => {
    const amounts = [500, 5000, 50000, 500000, 2000000];
    for (let i = 0; i < amounts.length; i++) {
      await ctx.prisma.transaction.create({
        data: {
          userId: ctx.user.id, type: 'TRANSFER', amount: BigInt(amounts[i]),
          fee: BigInt(0), currency: 'USD', status: 'COMPLETED',
          reference: `ref-dist-${i}`,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/amount-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(5);
    expect(body.buckets.length).toBe(5);
    expect(body.percentiles.p50).toBeDefined();
    expect(Number(body.minAmount)).toBe(500);
    expect(Number(body.maxAmount)).toBe(2000000);
    expect(Number(body.avgAmount)).toBeGreaterThan(0);
  });
});

describe('user profiles engagement profile', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns engagement for minimal profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/engagement-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engagementScore).toBeGreaterThanOrEqual(0);
    expect(body.engagementLevel).toBeDefined();
    expect(body.profileCompleteness).toBeGreaterThanOrEqual(0);
    expect(body.completenessChecks).toBeInstanceOf(Array);
  });

  it('reflects higher engagement with complete profile', async () => {
    await ctx.prisma.user.update({
      where: { id: ctx.user.id },
      data: {
        name: 'Test User', phone: '+1234567890',
        locale: 'en', timezone: 'UTC',
        lastLoginAt: new Date(),
      },
    });
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.userSession.create({
        data: {
          userId: ctx.user.id, deviceId: `device-${i % 2}`,
          ip: `192.168.1.${i}`, expiresAt: new Date(Date.now() + 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/engagement-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profileCompleteness).toBeGreaterThan(0);
    expect(body.loginCount).toBeGreaterThanOrEqual(5);
    expect(body.distinctDevices).toBeGreaterThanOrEqual(2);
    expect(body.recencyScore).toBeGreaterThan(0);
  });
});

describe('user sessions anomaly detection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/anomaly-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(0);
    expect(body.riskLevel).toBe('none');
    expect(body.flaggedSessions).toBeInstanceOf(Array);
  });

  it('flags sessions with anomalous patterns', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.userSession.create({
        data: {
          userId: ctx.user.id, deviceId: 'main-device',
          ip: '192.168.1.1', expiresAt: new Date(Date.now() + 86400000),
          createdAt: new Date(Date.now() - i * 86400000),
        },
      });
    }
    await ctx.prisma.userSession.create({
      data: {
        userId: ctx.user.id, deviceId: 'unknown-device',
        ip: '10.0.0.99', expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(Date.now() - 1000),
        revokedAt: new Date(Date.now() - 500),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/anomaly-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBeGreaterThanOrEqual(6);
    expect(body.anomalyCount).toBeGreaterThanOrEqual(1);
    expect(body.flaggedSessions.length).toBeGreaterThanOrEqual(1);
    const flagged = body.flaggedSessions.find((f: any) => f.reasons.includes('unique_ip'));
    expect(flagged).toBeDefined();
  });
});
