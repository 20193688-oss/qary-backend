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
    payload: { email: 'b62@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b62@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('user sessions device fingerprinting', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no extra sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/device-fingerprinting',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBeGreaterThanOrEqual(0);
    expect(body.sharingRisk).toBeDefined();
    expect(body.deviceBreakdown).toBeDefined();
  });

  it('analyzes device fingerprints across sessions', async () => {
    await ctx.prisma.userSession.create({
      data: {
        userId: ctx.user.id, deviceId: 'dev-1',
        deviceName: 'Chrome/Windows', ip: '10.0.0.1',
        userAgent: 'Chrome/Windows',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await ctx.prisma.userSession.create({
      data: {
        userId: ctx.user.id, deviceId: 'dev-2',
        deviceName: 'Safari/Mac', ip: '10.0.0.2',
        userAgent: 'Safari/Mac',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await ctx.prisma.userSession.create({
      data: {
        userId: ctx.user.id, deviceId: 'dev-3',
        deviceName: 'Chrome/Windows', ip: '10.0.0.1',
        userAgent: 'Chrome/Windows',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/device-fingerprinting',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBeGreaterThanOrEqual(3);
    expect(body.uniqueDevices).toBeGreaterThanOrEqual(2);
    expect(body.uniqueIPs).toBeGreaterThanOrEqual(2);
    expect(body.deviceBreakdown.length).toBeGreaterThanOrEqual(2);
    expect(body.ipBreakdown.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ant expenses recurring detection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/recurring-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.recurringCount).toBe(0);
    expect(body.patterns).toEqual([]);
  });

  it('detects recurring expense patterns', async () => {
    for (let i = 0; i < 4; i++) {
      await ctx.prisma.antExpense.create({
        data: {
          userId: ctx.user.id,
          merchantName: 'Netflix',
          description: 'Streaming sub',
          amount: BigInt(1599),
          currency: 'USD',
          category: 'entertainment',
          createdAt: new Date(2025, 3 + i, 15),
        },
      });
    }
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id,
        merchantName: 'Coffee Shop',
        description: 'Latte',
        amount: BigInt(500),
        currency: 'USD',
        category: 'food',
        createdAt: new Date(2025, 6, 1),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/recurring-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(5);
    expect(body.recurringCount).toBeGreaterThanOrEqual(0);
    expect(body.oneTimeCount).toBeGreaterThanOrEqual(0);
    expect(body.recurringMonthlyTotal).toBeDefined();
  });
});

describe('bank accounts utilization report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/utilization-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.utilizationRate).toBe(0);
    expect(body.byAccount).toEqual([]);
  });

  it('analyzes account utilization', async () => {
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, accountNumber: '111222333',
        bankName: 'Chase', currency: 'USD', status: 'verified',
        holderName: 'Test User',
      },
    });
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, accountNumber: '444555666',
        bankName: 'Citi', currency: 'EUR', status: 'unverified',
        holderName: 'Test User',
        createdAt: new Date(Date.now() - 120 * 86400000),
        updatedAt: new Date(Date.now() - 120 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/utilization-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.byAccount.length).toBe(2);
    expect(body.activelyUsed + body.underutilized + body.dormant).toBe(2);
    expect(body.utilizationRate).toBeDefined();
  });
});

describe('beneficiaries trust score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/trust-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.avgTrustScore).toBe(0);
    expect(body.scores).toEqual([]);
  });

  it('computes trust scores for beneficiaries', async () => {
    await ctx.prisma.beneficiary.create({
      data: {
        userId: ctx.user.id, name: 'Alice',
        bankAccountNumber: 'ACC123', bankName: 'Chase',
        currency: 'USD', verified: true,
        email: 'alice@test.com',
        createdAt: new Date(Date.now() - 200 * 86400000),
      },
    });
    await ctx.prisma.beneficiary.create({
      data: {
        userId: ctx.user.id, name: 'Bob',
        currency: 'USD',
        createdAt: new Date(Date.now() - 5 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/trust-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(2);
    expect(body.avgTrustScore).toBeGreaterThan(0);
    expect(body.scores.length).toBe(2);
    expect(body.scores[0].trustScore).toBeGreaterThanOrEqual(body.scores[1].trustScore);
    expect(body.highTrust + body.mediumTrust + body.lowTrust).toBe(2);
  });
});

describe('business profile document expiry tracker', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/document-expiry-tracker',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('tracks document expiry status', async () => {
    await ctx.prisma.businessProfile.create({
      data: {
        userId: ctx.user.id,
        businessName: 'Acme Corp',
        registrationNumber: 'REG123',
        country: 'US',
        status: 'VERIFIED',
        registrationExpiry: new Date(Date.now() + 90 * 86400000),
        taxCertExpiry: new Date(Date.now() - 10 * 86400000),
        licenseExpiry: new Date(Date.now() + 15 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/document-expiry-tracker',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDocuments).toBe(5);
    expect(body.validCount + body.expiringCount + body.expiredCount + body.unknownCount).toBe(5);
    expect(body.expiredCount).toBeGreaterThanOrEqual(1);
    expect(body.urgency).toBe('critical');
    expect(body.documents.length).toBe(5);
  });
});
