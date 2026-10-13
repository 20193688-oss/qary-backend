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
    payload: { email: 'b47@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b47@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ant-expenses action plan', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty plan with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/action-plan',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.actions).toBeInstanceOf(Array);
    expect(body.actions.length).toBe(0);
    expect(body.totalPotentialSavings).toBe('0');
  });

  it('prioritizes actions by savings ratio', async () => {
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id, category: 'streaming', merchantName: 'Netflix',
        amount: BigInt(1500), currency: 'USD', frequency: 'monthly',
        monthlyTotal: BigInt(1500), yearlyProjection: BigInt(18000),
        savingsIfCut: BigInt(1500), isActive: true,
      },
    });
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id, category: 'food', merchantName: 'Coffee Shop',
        amount: BigInt(500), currency: 'USD', frequency: 'daily',
        monthlyTotal: BigInt(15000), yearlyProjection: BigInt(180000),
        savingsIfCut: BigInt(3000), isActive: true,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/action-plan',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(2);
    expect(body.actions.length).toBe(2);
    expect(body.actions[0].merchantName).toBe('Netflix');
    expect(body.actions[0].priority).toBe('high');
    expect(body.actions[1].priority).toBe('medium');
    expect(body.summary.highPriority).toBe(1);
    expect(body.totalPotentialSavings).toBe('4500');
  });
});

describe('bank-accounts health check', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns none rating with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/health-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.healthScore).toBe(0);
    expect(body.rating).toBe('none');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('calculates health with mixed accounts', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'Bank A', accountNumber: '1234567890', rail: 'ACH', country: 'US', currency: 'USD', holderName: 'Test User' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'Bank B', accountNumber: '9876543210', rail: 'SEPA', country: 'DE', currency: 'EUR', holderName: 'Test User' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/health-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.checks.hasDefault).toBe(true);
    expect(body.checks.multiRail).toBe(true);
    expect(body.checks.multiCountry).toBe(true);
    expect(body.healthScore).toBeGreaterThan(0);
    expect(body.rating).toBeDefined();
  });
});

describe('beneficiaries currency exposure', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty exposure with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/currency-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.coveredCurrencies).toBeInstanceOf(Array);
    expect(body.gaps).toBeInstanceOf(Array);
  });

  it('detects gaps and coverage', async () => {
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000), status: 'ACTIVE', isDefault: true },
    });
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'EUR', balance: BigInt(30000), status: 'ACTIVE', isDefault: false },
    });

    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'recip47@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'recip47@kopera.io', code: reg2.json().debugOtp },
    });
    const recipientId = v2.json().user.id;

    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Alice', recipientUserId: recipientId, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/currency-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(1);
    expect(body.coveredCurrencies).toContain('USD');
    expect(body.gaps).toContain('EUR');
    expect(body.byCurrency.USD.beneficiaryCount).toBe(1);
    expect(body.byCurrency.USD.hasWallet).toBe(true);
    expect(body.byCurrency.EUR.beneficiaryCount).toBe(0);
    expect(body.byCurrency.EUR.hasWallet).toBe(true);
  });
});

describe('business-profile risk profile', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/risk-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('calculates risk profile after setup', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxId: 'TAX123', taxIdType: 'RUC', taxIdCountry: 'PE', legalName: 'Test Corp', legalRepName: 'John', legalRepDocNumber: 'DOC1' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile/screening',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { riskScore: 30, complianceScore: 85 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/risk-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.riskLevel).toBeDefined();
    expect(body.overallScore).toBeGreaterThan(0);
    expect(body.factors.length).toBe(5);
    expect(body.riskScore).toBe(30);
    expect(body.complianceScore).toBe(85);
    expect(body.hasScreening).toBe(true);
    expect(body.completeness).toBeGreaterThan(0);
  });
});

describe('disputes financial impact', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zeros with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/financial-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.totalDisputed).toBe('0');
    expect(body.totalRecovered).toBe('0');
    expect(body.totalLost).toBe('0');
    expect(body.recoveryRate).toBe(0);
  });

  it('analyzes financial impact across outcomes', async () => {
    const gp1 = await ctx.prisma.gatewayPayment.create({
      data: { userId: ctx.user.id, gatewayId: 'gw1', externalId: 'ext1', amount: BigInt(10000), currency: 'USD', status: 'COMPLETED', provider: 'stripe' },
    });
    const gp2 = await ctx.prisma.gatewayPayment.create({
      data: { userId: ctx.user.id, gatewayId: 'gw1', externalId: 'ext2', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED', provider: 'stripe' },
    });
    const gp3 = await ctx.prisma.gatewayPayment.create({
      data: { userId: ctx.user.id, gatewayId: 'gw1', externalId: 'ext3', amount: BigInt(8000), currency: 'EUR', status: 'COMPLETED', provider: 'stripe' },
    });

    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, gatewayPaymentId: gp1.id, reason: 'fraud',
        amount: BigInt(10000), currency: 'USD', status: 'WON',
        evidenceDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), resolvedAt: new Date(),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, gatewayPaymentId: gp2.id, reason: 'fraud',
        amount: BigInt(5000), currency: 'USD', status: 'LOST',
        evidenceDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), resolvedAt: new Date(),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, gatewayPaymentId: gp3.id, reason: 'unauthorized',
        amount: BigInt(8000), currency: 'EUR', status: 'OPENED',
        evidenceDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/financial-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(3);
    expect(body.totalRecovered).toBe('10000');
    expect(body.totalLost).toBe('5000');
    expect(body.pendingExposure).toBe('8000');
    expect(body.recoveryRate).toBeGreaterThan(0);
    expect(body.byCurrency.USD).toBeDefined();
    expect(body.byCurrency.EUR).toBeDefined();
    expect(body.byCurrency.EUR.pending).toBe('8000');
  });
});
