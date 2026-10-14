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
    payload: { email: 'b83@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b83@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('expense compliance check', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/compliance-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.complianceLevel).toBe('no_data');
  });

  it('checks compliance with expenses', async () => {
    await ctx.prisma.antExpense.create({
      data: { userId: ctx.user.id, amount: BigInt(5000), currency: 'USD', merchant: 'Store A', description: 'Office supplies', category: 'office' },
    });
    await ctx.prisma.antExpense.create({
      data: { userId: ctx.user.id, amount: BigInt(3000), currency: 'USD', merchant: 'Store B', category: 'travel' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/compliance-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(2);
    expect(body.complianceScore).toBeGreaterThan(0);
    expect(body.complianceLevel).toBeDefined();
  });
});

describe('account recovery readiness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/recovery-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.readinessLevel).toBe('no_data');
  });

  it('checks readiness with accounts', async () => {
    await ctx.prisma.bankAccount.create({
      data: { userId: ctx.user.id, bankName: 'Bank A', accountNumber: '1234', routingNumber: '001', currency: 'USD', isDefault: true, verified: true },
    });
    await ctx.prisma.bankAccount.create({
      data: { userId: ctx.user.id, bankName: 'Bank B', accountNumber: '5678', routingNumber: '002', currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/recovery-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.readinessScore).toBeGreaterThan(0);
    expect(body.checks.length).toBe(5);
    expect(body.readinessLevel).toBeDefined();
  });
});

describe('beneficiary verification status', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/verification-status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.verificationLevel).toBe('no_data');
  });

  it('analyzes verification with beneficiaries', async () => {
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, name: 'Alice', bankName: 'Bank A', accountNumber: '111', currency: 'USD', verified: true },
    });
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, name: 'Bob', bankName: 'Bank B', accountNumber: '222', currency: 'EUR' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/verification-status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(2);
    expect(body.verificationRate).toBeDefined();
    expect(body.breakdown.verified).toBe(1);
    expect(body.verificationLevel).toBeDefined();
  });
});

describe('business continuity score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/continuity-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('scores continuity with profile', async () => {
    await ctx.prisma.businessProfile.create({
      data: { userId: ctx.user.id, companyName: 'Acme Corp', registrationNumber: 'REG123', country: 'US', status: 'verified', phone: '+1234567890', contactEmail: 'info@acme.com' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/continuity-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.continuityScore).toBeGreaterThan(0);
    expect(body.checks.length).toBe(5);
    expect(body.continuityLevel).toBeDefined();
  });
});

describe('dispute cost analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/cost-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.costLevel).toBe('no_data');
  });

  it('analyzes cost with disputes', async () => {
    await ctx.prisma.dispute.create({
      data: { userId: ctx.user.id, type: 'chargeback', status: 'resolved', amount: BigInt(25000), currency: 'USD', reason: 'unauthorized' },
    });
    await ctx.prisma.dispute.create({
      data: { userId: ctx.user.id, type: 'complaint', status: 'open', amount: BigInt(10000), currency: 'USD', reason: 'service_issue' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/cost-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(2);
    expect(body.totalDisputedAmount).toBeDefined();
    expect(body.breakdown.length).toBeGreaterThan(0);
    expect(body.costLevel).toBeDefined();
  });
});
