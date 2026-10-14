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
    payload: { email: 'b67@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b67@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('wallet risk exposure', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/risk-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(0);
    expect(body.riskLevel).toBe('none');
  });

  it('assesses risk across wallets', async () => {
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true, balance: BigInt(50000) },
    });
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'EUR', isDefault: false, balance: BigInt(0), frozen: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/risk-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(2);
    expect(body.overallRiskScore).toBeGreaterThan(0);
    expect(body.walletRisks.length).toBe(2);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('ant expense velocity report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/velocity-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.acceleration).toBe('none');
  });

  it('calculates expense velocity', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.antExpense.create({
        data: {
          userId: ctx.user.id, merchant: `Store ${i}`, amount: BigInt(1000),
          currency: 'USD', category: 'food',
          createdAt: new Date(Date.now() - (i * 5) * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/velocity-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(5);
    expect(body.dailyAverage).toBeGreaterThan(0);
    expect(body.weeklyAverage).toBeGreaterThan(0);
    expect(body.periodComparison).toBeDefined();
    expect(body.periodComparison.last30Days.count).toBeGreaterThan(0);
  });
});

describe('bank account consolidation advice', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/consolidation-advice',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.canConsolidate).toBe(false);
  });

  it('detects duplicate currency accounts', async () => {
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, holderName: 'Test', bankName: 'Bank A',
        accountNumber: '1234', routingNumber: 'R1', currency: 'USD',
      },
    });
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, holderName: 'Test', bankName: 'Bank B',
        accountNumber: '5678', routingNumber: 'R2', currency: 'USD',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/consolidation-advice',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.canConsolidate).toBe(true);
    expect(body.duplicateCurrencies.length).toBe(1);
    expect(body.duplicateCurrencies[0].currency).toBe('USD');
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('beneficiary geographic spread', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/geographic-spread',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.diversityScore).toBe(0);
  });

  it('analyzes geographic distribution', async () => {
    await ctx.prisma.beneficiary.create({
      data: {
        userId: ctx.user.id, name: 'Alice', bankName: 'Bank A',
        accountNumber: '111', country: 'US', currency: 'USD',
      },
    });
    await ctx.prisma.beneficiary.create({
      data: {
        userId: ctx.user.id, name: 'Bob', bankName: 'Bank B',
        accountNumber: '222', country: 'GB', currency: 'GBP',
      },
    });
    await ctx.prisma.beneficiary.create({
      data: {
        userId: ctx.user.id, name: 'Charlie', bankName: 'Bank C',
        accountNumber: '333', country: 'US', currency: 'USD',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/geographic-spread',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(3);
    expect(body.countries.length).toBe(2);
    expect(body.topCountry.country).toBe('US');
    expect(body.diversityScore).toBeGreaterThan(0);
  });
});

describe('business profile health score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/health-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('calculates health score', async () => {
    await ctx.prisma.businessProfile.create({
      data: {
        userId: ctx.user.id, businessName: 'Acme Corp',
        registrationNumber: 'REG123', country: 'US',
        status: 'VERIFIED', riskScore: 20, reputationScore: 80,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/health-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthScore).toBeGreaterThan(0);
    expect(body.healthLevel).toBeDefined();
    expect(body.factors.length).toBeGreaterThan(0);
  });
});
