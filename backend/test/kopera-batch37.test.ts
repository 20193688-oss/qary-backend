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
    payload: { email: 'b37@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b37@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ant-expense trend analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns trend after creating expenses', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { category: 'food', merchantName: 'CoffeeShop', amount: 5, currency: 'USD', frequency: 'daily', monthlyTotal: 150, yearlyProjection: 1800, savingsIfCut: 100 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { category: 'transport', merchantName: 'Uber', amount: 15, currency: 'USD', frequency: 'weekly', monthlyTotal: 60, yearlyProjection: 720 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/trend-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(2);
    expect(body.activeCount).toBe(2);
    expect(body.dismissedCount).toBe(0);
    expect(typeof body.totalActiveMonthly).toBe('string');
    expect(typeof body.avgPerExpense).toBe('string');
    expect(body.byFrequency).toBeDefined();
    expect(body.byFrequency.daily).toBeDefined();
    expect(body.byFrequency.weekly).toBeDefined();
    expect(body.topMerchants).toBeInstanceOf(Array);
    expect(body.topMerchants.length).toBe(2);
  });

  it('returns empty trend with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/trend-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.activeCount).toBe(0);
    expect(body.totalActiveMonthly).toBe('0');
  });
});

describe('gateway fee analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns fee analysis after payments', async () => {
    const txn1 = await (ctx.prisma as any).transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED', amount: BigInt(10000), currency: 'USD', reference: 'ref-fa-1' },
    });
    await (ctx.prisma as any).gatewayPayment.create({
      data: { transactionId: txn1.id, gateway: 'stripe', externalId: 'ext-fa-1', userId: ctx.user.id, amount: BigInt(10000), currency: 'USD', status: 'CAPTURED', paymentMethod: 'CARD', gatewayFee: BigInt(320) },
    });
    const txn2 = await (ctx.prisma as any).transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED', amount: BigInt(50000), currency: 'USD', reference: 'ref-fa-2' },
    });
    await (ctx.prisma as any).gatewayPayment.create({
      data: { transactionId: txn2.id, gateway: 'stripe', externalId: 'ext-fa-2', userId: ctx.user.id, amount: BigInt(50000), currency: 'USD', status: 'CAPTURED', paymentMethod: 'BANK_TRANSFER', gatewayFee: BigInt(250) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/fee-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(2);
    expect(typeof body.totalVolume).toBe('string');
    expect(typeof body.totalFees).toBe('string');
    expect(typeof body.overallEffectiveRate).toBe('number');
    expect(body.cheapestMethod).toBeDefined();
    expect(body.mostExpensiveMethod).toBeDefined();
    expect(body.byMethod.CARD).toBeDefined();
    expect(body.byMethod.BANK_TRANSFER).toBeDefined();
  });

  it('returns empty fee analysis with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/fee-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.totalFees).toBe('0');
    expect(body.overallEffectiveRate).toBe(0);
    expect(body.cheapestMethod).toBeNull();
  });
});

describe('invoice tax summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns tax summary after invoices', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'FACTURA', currency: 'PEN', subtotal: 1000, country: 'PE', senderName: 'Test Corp' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'BOLETA', currency: 'PEN', subtotal: 500, country: 'PE', senderName: 'Test Corp' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/tax-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(typeof body.totalSubtotal).toBe('string');
    expect(typeof body.totalTax).toBe('string');
    expect(typeof body.totalAmount).toBe('string');
    expect(typeof body.effectiveTaxRate).toBe('number');
    expect(body.byCountry.PE).toBeDefined();
    expect(body.byCountry.PE.invoiceCount).toBe(2);
    expect(body.byType.FACTURA).toBeDefined();
    expect(body.byType.BOLETA).toBeDefined();
  });

  it('returns empty tax summary with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/tax-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.totalTax).toBe('0');
    expect(body.effectiveTaxRate).toBe(0);
  });
});

describe('kyc renewal readiness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns readiness after kyc start', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { documentType: 'DNI', documentNumber: '12345678', documentCountry: 'PE', firstName: 'Test', lastName: 'User' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/renewal-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kycExists).toBe(true);
    expect(body.status).toBe('IN_REVIEW');
    expect(typeof body.completionPercent).toBe('number');
    expect(body.missingFields).toBeInstanceOf(Array);
    expect(body.recommendations).toBeInstanceOf(Array);
  });

  it('returns no-kyc readiness without start', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/renewal-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kycExists).toBe(false);
    expect(body.needsRenewal).toBe(false);
    expect(body.recommendations).toContain('Start KYC verification');
  });
});

describe('loan amortization health', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns health after loan approval', async () => {
    const applyRes = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10000, currency: 'USD', termMonths: 12 },
    });
    const loanId = applyRes.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/amortization-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeLoans).toBe(1);
    expect(typeof body.healthScore).toBe('number');
    expect(typeof body.totalExpectedPaid).toBe('string');
    expect(typeof body.totalActualPaid).toBe('string');
    expect(typeof body.paymentAdherence).toBe('number');
    expect(body.loanDetails).toBeInstanceOf(Array);
    expect(body.loanDetails).toHaveLength(1);
  });

  it('returns perfect health with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/amortization-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeLoans).toBe(0);
    expect(body.healthScore).toBe(100);
    expect(body.paymentAdherence).toBe(100);
  });
});
