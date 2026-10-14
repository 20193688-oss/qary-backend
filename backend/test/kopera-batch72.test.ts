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
    payload: { email: 'b72@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b72@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('session concurrency analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/concurrency-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(0);
    expect(body.concurrencyLevel).toBe('none');
  });

  it('analyzes session concurrency', async () => {
    await ctx.prisma.userSession.create({
      data: {
        userId: ctx.user.id, ipAddress: '1.2.3.4',
        userAgent: 'Chrome', status: 'active',
      },
    });
    await ctx.prisma.userSession.create({
      data: {
        userId: ctx.user.id, ipAddress: '5.6.7.8',
        userAgent: 'Firefox', status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/concurrency-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(2);
    expect(body.activeSessions).toBe(2);
    expect(body.peakConcurrent).toBe(2);
    expect(body.concurrencyLevel).toBeDefined();
  });
});

describe('expense budget alignment', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/budget-alignment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.totalSpent).toBe('0');
  });

  it('analyzes budget alignment', async () => {
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id, amount: BigInt(5000), currency: 'USD',
        category: 'food', description: 'Lunch',
      },
    });
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id, amount: BigInt(3000), currency: 'USD',
        category: 'transport', description: 'Taxi',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/budget-alignment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(2);
    expect(body.categorySpending.length).toBeGreaterThan(0);
    expect(body.budgetHealth).toBeDefined();
  });
});

describe('bank account security audit', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/security-audit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.securityScore).toBe(100);
  });

  it('audits account security', async () => {
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, accountNumber: '123456',
        currency: 'USD', holderName: 'Test User',
        bankName: 'Test Bank', isDefault: true,
      },
    });
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, accountNumber: '789012',
        currency: 'EUR', isDefault: false,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/security-audit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.securityScore).toBeLessThanOrEqual(100);
    expect(body.securityLevel).toBeDefined();
  });
});

describe('beneficiary payment frequency', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/payment-frequency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.avgTransactionsPerBeneficiary).toBe(0);
  });

  it('analyzes payment frequency', async () => {
    await ctx.prisma.beneficiary.create({
      data: {
        userId: ctx.user.id, nickname: 'Alice',
        accountNumber: '111', bankCode: 'BANK1', currency: 'USD',
      },
    });
    await ctx.prisma.beneficiary.create({
      data: {
        userId: ctx.user.id, nickname: 'Bob',
        accountNumber: '222', bankCode: 'BANK2', currency: 'USD',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/payment-frequency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(2);
    expect(body.dormantRecipients.length).toBeGreaterThanOrEqual(0);
  });
});

describe('business operational readiness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/operational-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('checks operational readiness', async () => {
    await ctx.prisma.businessProfile.create({
      data: {
        userId: ctx.user.id, businessName: 'Test Corp',
        registrationNumber: 'REG123', industry: 'Tech',
        status: 'VERIFIED',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/operational-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(body.readinessScore).toBeGreaterThan(0);
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.passedChecks).toBeGreaterThan(0);
  });
});
