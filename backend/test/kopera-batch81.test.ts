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
    payload: { email: 'b81@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b81@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('card usage pattern', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/usage-pattern',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.usageLevel).toBe('no_data');
  });

  it('analyzes usage with cards', async () => {
    await ctx.prisma.tokenizedCard.create({
      data: { userId: ctx.user.id, last4: '1234', brand: 'visa', expiryMonth: 12, expiryYear: 2027, token: 'tok1', status: 'ACTIVE' },
    });
    await ctx.prisma.tokenizedCard.create({
      data: { userId: ctx.user.id, last4: '5678', brand: 'mastercard', expiryMonth: 6, expiryYear: 2025, token: 'tok2', status: 'ACTIVE' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/usage-pattern',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(2);
    expect(body.activeCards).toBe(2);
    expect(body.usageScore).toBeGreaterThan(0);
    expect(body.cardBreakdown.length).toBe(2);
  });
});

describe('limit capacity planning', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no limits', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/capacity-planning',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(0);
    expect(body.capacityLevel).toBe('no_data');
  });

  it('plans capacity with limits', async () => {
    await ctx.prisma.transactionLimit.create({
      data: { userId: ctx.user.id, currency: 'USD', limitType: 'DAILY', maxAmount: BigInt(10000), currentUsage: BigInt(9800), periodStart: new Date() },
    });
    await ctx.prisma.transactionLimit.create({
      data: { userId: ctx.user.id, currency: 'USD', limitType: 'MONTHLY', maxAmount: BigInt(100000), currentUsage: BigInt(50000), periodStart: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/capacity-planning',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLimits).toBe(2);
    expect(body.capacityScore).toBeGreaterThan(0);
    expect(body.planning.length).toBe(2);
    expect(body.capacityLevel).toBeDefined();
  });
});

describe('transaction velocity monitor', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/velocity-monitor',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.velocityLevel).toBe('no_data');
  });

  it('monitors velocity with transactions', async () => {
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED' },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'TRANSFER', amount: BigInt(3000), currency: 'USD', status: 'COMPLETED' },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', amount: BigInt(8000), currency: 'EUR', status: 'COMPLETED' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/velocity-monitor',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(3);
    expect(body.velocityScore).toBeGreaterThan(0);
    expect(body.peakHour).toBeDefined();
    expect(body.velocityLevel).toBeDefined();
  });
});

describe('profile security audit', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('audits security of existing profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/security-audit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalChecks).toBe(5);
    expect(body.auditScore).toBeGreaterThanOrEqual(0);
    expect(body.securityLevel).toBeDefined();
    expect(body.checks.length).toBe(5);
  });

  it('shows improved security with verified profile', async () => {
    await ctx.prisma.user.update({
      where: { id: ctx.user.id },
      data: { emailVerified: true, phoneVerified: true, mfaEnabled: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/security-audit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.passedChecks).toBeGreaterThanOrEqual(3);
    expect(body.auditScore).toBeGreaterThan(50);
  });
});

describe('session risk indicators', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/risk-indicators',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(0);
    expect(body.riskLevel).toBe('no_data');
  });

  it('evaluates risk with sessions', async () => {
    await ctx.prisma.userSession.create({
      data: { userId: ctx.user.id, token: 'sess1', ipAddress: '1.2.3.4', userAgent: 'Chrome', expiresAt: new Date(Date.now() + 86400000) },
    });
    await ctx.prisma.userSession.create({
      data: { userId: ctx.user.id, token: 'sess2', ipAddress: '5.6.7.8', userAgent: 'Firefox', expiresAt: new Date(Date.now() + 86400000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/risk-indicators',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(2);
    expect(body.indicators.length).toBe(4);
    expect(body.riskLevel).toBeDefined();
    expect(body.uniqueIps).toBe(2);
  });
});
