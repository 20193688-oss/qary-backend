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
    payload: { email: 'b78@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b78@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('event retention compliance', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns data with baseline events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/retention-compliance',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThan(0);
    expect(body.complianceLevel).toBeDefined();
    expect(body.retentionScore).toBeGreaterThanOrEqual(0);
  });

  it('analyzes retention with additional events', async () => {
    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, type: 'login', eventType: 'auth.login', payload: {} },
    });
    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, type: 'transfer', eventType: 'payment.sent', payload: {} },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/retention-compliance',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThan(2);
    expect(body.categories.length).toBeGreaterThan(0);
    expect(body.retentionScore).toBeGreaterThan(0);
  });
});

describe('fx volatility exposure', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/volatility-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.exposureLevel).toBe('no_data');
  });

  it('analyzes exposure with conversions', async () => {
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'FX_CONVERSION', amount: BigInt(10000), currency: 'USD', status: 'COMPLETED', fromCurrency: 'USD', toCurrency: 'EUR' },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'FX_CONVERSION', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED', fromCurrency: 'USD', toCurrency: 'GBP' },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'FX_CONVERSION', amount: BigInt(20000), currency: 'USD', status: 'COMPLETED', fromCurrency: 'USD', toCurrency: 'EUR' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/volatility-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(3);
    expect(body.currencyPairs.length).toBe(2);
    expect(body.volatilityScore).toBeGreaterThanOrEqual(0);
    expect(body.exposureLevel).toBeDefined();
  });
});

describe('gateway latency analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/latency-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.latencyLevel).toBe('no_data');
  });

  it('analyzes latency with payments', async () => {
    const txn = await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED' },
    });
    await ctx.prisma.gatewayPayment.create({
      data: { transactionId: txn.id, gateway: 'stripe', externalId: 'ext1', status: 'COMPLETED', amount: BigInt(5000), currency: 'USD' },
    });
    const txn2 = await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', amount: BigInt(3000), currency: 'USD', status: 'COMPLETED' },
    });
    await ctx.prisma.gatewayPayment.create({
      data: { transactionId: txn2.id, gateway: 'stripe', externalId: 'ext2', status: 'COMPLETED', amount: BigInt(3000), currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/latency-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(2);
    expect(body.gatewayBreakdown.length).toBe(1);
    expect(body.gatewayBreakdown[0].gateway).toBe('stripe');
    expect(body.latencyScore).toBeGreaterThan(0);
  });
});

describe('invoice payment velocity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/payment-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.velocityLevel).toBe('no_data');
  });

  it('analyzes velocity with invoices', async () => {
    await ctx.prisma.invoice.create({
      data: { senderUserId: ctx.user.id, recipientEmail: 'a@b.com', amount: BigInt(10000), currency: 'USD', status: 'PAID', paidAt: new Date() },
    });
    await ctx.prisma.invoice.create({
      data: { senderUserId: ctx.user.id, recipientEmail: 'c@d.com', amount: BigInt(5000), currency: 'USD', status: 'SENT' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/payment-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(body.velocityScore).toBeGreaterThan(0);
    expect(body.statusBreakdown).toBeDefined();
    expect(body.velocityLevel).toBeDefined();
  });
});

describe('kyc renewal forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no kyc profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/renewal-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('forecasts renewal with profile', async () => {
    await ctx.prisma.kycProfile.create({
      data: { userId: ctx.user.id, level: 'FULL', status: 'VERIFIED', documentType: 'passport', documentNumber: 'P123', country: 'US' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/renewal-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.renewalStatus).toBe('current');
    expect(body.renewalScore).toBeGreaterThan(50);
    expect(body.checks.length).toBe(4);
    expect(body.totalChecks).toBe(4);
  });
});
