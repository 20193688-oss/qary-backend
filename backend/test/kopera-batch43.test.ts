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
    payload: { email: 'b43@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b43@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ant-expense merchant concentration', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty concentration with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/merchant-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalMerchants).toBe(0);
    expect(body.totalMonthlySpend).toBe('0');
    expect(body.herfindahlIndex).toBe(0);
    expect(body.concentrationLevel).toBe('none');
    expect(body.merchantShares).toBeInstanceOf(Array);
    expect(body.dominantMerchant).toBeNull();
  });

  it('analyzes concentration after adding expenses', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { category: 'streaming', merchantName: 'Netflix', amount: 15, currency: 'USD', frequency: 'monthly', monthlyTotal: 15, yearlyProjection: 180 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { category: 'streaming', merchantName: 'Spotify', amount: 10, currency: 'USD', frequency: 'monthly', monthlyTotal: 10, yearlyProjection: 120 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/merchant-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalMerchants).toBe(2);
    expect(Number(body.totalMonthlySpend)).toBeGreaterThan(0);
    expect(body.herfindahlIndex).toBeGreaterThan(0);
    expect(body.merchantShares.length).toBe(2);
    expect(body.concentrationLevel).toBeDefined();
  });
});

describe('gateway settlement velocity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty velocity with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/settlement-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.settledCount).toBe(0);
    expect(body.unsettledCount).toBe(0);
    expect(body.avgSettlementHours).toBe(0);
    expect(body.fastestMethod).toBeNull();
    expect(body.slowestMethod).toBeNull();
  });

  it('tracks velocity after settling payments', async () => {
    const txn = await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED', amount: BigInt(5000), currency: 'USD', reference: 'GW-V1' },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn.id, status: 'SETTLED', paymentMethod: 'CARD',
        amount: BigInt(5000), currency: 'USD', gatewayFee: BigInt(175),
        settledAt: new Date(), idempotencyKey: 'vel-1',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/settlement-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(1);
    expect(body.settledCount).toBe(1);
    expect(body.unsettledCount).toBe(0);
    expect(body.fastestMethod).toBe('CARD');
    expect(body.slowestMethod).toBe('CARD');
    expect(body.byMethod.CARD).toBeDefined();
    expect(body.byMethod.CARD.count).toBe(1);
  });
});

describe('invoice receiver analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty analysis with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/receiver-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.uniqueReceivers).toBe(0);
    expect(body.receivers).toBeInstanceOf(Array);
    expect(body.topReceiver).toBeNull();
  });

  it('analyzes receivers after creating invoices', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'FACTURA', currency: 'PEN', subtotal: 100, country: 'PE', receiverName: 'Acme Corp' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'BOLETA', currency: 'PEN', subtotal: 50, country: 'PE', receiverName: 'Beta Ltd' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/receiver-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(body.uniqueReceivers).toBe(2);
    expect(body.receivers.length).toBe(2);
    expect(body.topReceiver).toBeDefined();
    expect(body.topReceiver.receiverName).toBeDefined();
  });
});

describe('kyc onboarding funnel', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty funnel with no profiles', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/onboarding-funnel',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalProfiles).toBe(0);
    expect(body.approvedCount).toBe(0);
    expect(body.rejectedCount).toBe(0);
    expect(body.approvalRate).toBe(0);
    expect(body.byStatus).toBeDefined();
  });

  it('tracks funnel after KYC submissions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { documentType: 'DNI', documentNumber: '12345678', documentCountry: 'PE', firstName: 'Juan', lastName: 'Perez' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/onboarding-funnel',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalProfiles).toBe(1);
    expect(body.approvedCount).toBe(1);
    expect(body.approvalRate).toBe(100);
    expect(body.byStatus.APPROVED).toBe(1);
    expect(body.byDocumentType.DNI).toBe(1);
    expect(body.byCountry.PE).toBe(1);
  });
});

describe('loan portfolio diversification', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty diversification with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/portfolio-diversification',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveLoans).toBe(0);
    expect(body.totalPrincipal).toBe('0');
    expect(body.byCurrency).toBeInstanceOf(Array);
    expect(body.byTermBucket).toBeInstanceOf(Array);
    expect(body.byRateBucket).toBeInstanceOf(Array);
    expect(body.concentrationRisk).toBe('none');
  });

  it('analyzes diversification after applying for loans', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10000, currency: 'USD', termMonths: 24 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5000, currency: 'PEN', termMonths: 12 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/portfolio-diversification',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveLoans).toBe(2);
    expect(Number(body.totalPrincipal)).toBeGreaterThan(0);
    expect(body.byCurrency.length).toBe(2);
    expect(body.byCurrency.find((c: any) => c.currency === 'USD')).toBeDefined();
    expect(body.byCurrency.find((c: any) => c.currency === 'PEN')).toBeDefined();
    expect(body.byTermBucket.length).toBeGreaterThan(0);
    expect(body.byRateBucket.length).toBeGreaterThan(0);
    expect(body.concentrationRisk).toBeDefined();
  });
});
