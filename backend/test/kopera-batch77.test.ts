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
    payload: { email: 'b77@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b77@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('expense category migration', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/category-migration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.migrationTrend).toBe('no_data');
    expect(body.categories).toEqual([]);
  });

  it('analyzes category distribution', async () => {
    await ctx.prisma.antExpense.create({
      data: { userId: ctx.user.id, category: 'food', amount: BigInt(5000), currency: 'USD', description: 'lunch' },
    });
    await ctx.prisma.antExpense.create({
      data: { userId: ctx.user.id, category: 'food', amount: BigInt(3000), currency: 'USD', description: 'dinner' },
    });
    await ctx.prisma.antExpense.create({
      data: { userId: ctx.user.id, category: 'transport', amount: BigInt(2000), currency: 'USD', description: 'taxi' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/category-migration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(3);
    expect(body.categories.length).toBe(2);
    expect(body.categories[0].name).toBe('food');
    expect(body.stabilityScore).toBeGreaterThan(0);
  });
});

describe('bank account dormancy risk', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/dormancy-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.riskLevel).toBe('no_data');
  });

  it('detects dormant accounts', async () => {
    await ctx.prisma.bankAccount.create({
      data: { userId: ctx.user.id, accountNumber: '111', holderName: 'Test', bankName: 'Bank A', currency: 'USD', lastUsedAt: new Date(Date.now() - 200 * 86400000) },
    });
    await ctx.prisma.bankAccount.create({
      data: { userId: ctx.user.id, accountNumber: '222', holderName: 'Test', bankName: 'Bank B', currency: 'EUR', lastUsedAt: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/dormancy-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.dormantCount).toBe(1);
    expect(body.riskLevel).toBe('moderate');
    expect(body.accounts.length).toBe(2);
  });
});

describe('beneficiary risk concentration', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/risk-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.concentrationLevel).toBe('no_data');
  });

  it('calculates concentration with beneficiaries', async () => {
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, name: 'Ben A', accountNumber: '111', bankName: 'BankA', country: 'US', currency: 'USD' },
    });
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, name: 'Ben B', accountNumber: '222', bankName: 'BankB', country: 'US', currency: 'USD' },
    });
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, name: 'Ben C', accountNumber: '333', bankName: 'BankC', country: 'UK', currency: 'GBP' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/risk-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(3);
    expect(body.concentrationScore).toBeGreaterThan(0);
    expect(body.topRecipients.length).toBeGreaterThan(0);
    expect(body.currencyDistribution).toBeDefined();
  });
});

describe('business regulatory readiness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/regulatory-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('assesses readiness with profile', async () => {
    await ctx.prisma.businessProfile.create({
      data: { userId: ctx.user.id, businessName: 'Test Corp', registrationNumber: 'REG123', taxId: 'TAX456', address: '123 St', industry: 'fintech', status: 'VERIFIED' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/regulatory-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.readinessScore).toBeGreaterThan(50);
    expect(body.readinessLevel).toBeDefined();
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.passedChecks).toBeGreaterThan(0);
  });
});

describe('dispute escalation effectiveness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/escalation-effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.effectivenessLevel).toBe('no_data');
  });

  it('measures escalation effectiveness', async () => {
    await ctx.prisma.dispute.create({
      data: { userId: ctx.user.id, transactionId: 'tx1', reason: 'fraud', amount: BigInt(5000), currency: 'USD', status: 'escalated', escalatedAt: new Date() },
    });
    await ctx.prisma.dispute.create({
      data: { userId: ctx.user.id, transactionId: 'tx2', reason: 'error', amount: BigInt(3000), currency: 'USD', status: 'resolved' },
    });
    await ctx.prisma.dispute.create({
      data: { userId: ctx.user.id, transactionId: 'tx3', reason: 'fraud', amount: BigInt(2000), currency: 'USD', status: 'OPENED' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/escalation-effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(3);
    expect(body.escalatedCount).toBe(1);
    expect(body.escalationRate).toBeGreaterThan(0);
    expect(body.effectivenessLevel).toBeDefined();
  });
});
