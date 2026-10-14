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
    payload: { email: 'b84@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b84@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('event channel distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no events beyond bootstrap', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/channel-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(0);
    expect(body.distributionScore).toBeDefined();
  });

  it('analyzes distribution with events', async () => {
    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, eventType: 'login', channel: 'web', payload: {} },
    });
    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, eventType: 'transfer', channel: 'mobile', payload: {} },
    });
    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, eventType: 'payment', channel: 'api', payload: {} },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/channel-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(3);
    expect(body.channels.length).toBeGreaterThanOrEqual(1);
    expect(body.distributionLevel).toBeDefined();
  });
});

describe('fx seasonal analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/seasonal-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.seasonalLevel).toBe('no_data');
  });

  it('analyzes seasonality with conversions', async () => {
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'FX_CONVERSION', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED' },
    });
    await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'FX_CONVERSION', amount: BigInt(8000), currency: 'EUR', status: 'COMPLETED' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/seasonal-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(2);
    expect(body.monthlyDistribution.length).toBe(12);
    expect(body.seasonalLevel).toBeDefined();
  });
});

describe('gateway retry analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/retry-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.retryLevel).toBe('no_data');
  });

  it('analyzes retries with payments', async () => {
    const txn = await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED' },
    });
    await ctx.prisma.gatewayPayment.create({
      data: { transactionId: txn.id, gateway: 'stripe', externalId: 'ext1', status: 'succeeded', amount: BigInt(5000), currency: 'USD' },
    });
    await ctx.prisma.gatewayPayment.create({
      data: { transactionId: txn.id, gateway: 'stripe', externalId: 'ext2', status: 'failed', amount: BigInt(5000), currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/retry-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(2);
    expect(body.uniqueTransactions).toBe(1);
    expect(body.retryLevel).toBeDefined();
  });
});

describe('invoice aging snapshot', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/aging-snapshot',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.agingLevel).toBe('no_data');
  });

  it('analyzes aging with invoices', async () => {
    await ctx.prisma.invoice.create({
      data: { senderId: ctx.user.id, recipientEmail: 'a@test.com', amount: BigInt(10000), currency: 'USD', status: 'sent', dueDate: new Date(Date.now() + 86400000) },
    });
    await ctx.prisma.invoice.create({
      data: { senderId: ctx.user.id, recipientEmail: 'b@test.com', amount: BigInt(20000), currency: 'USD', status: 'paid', dueDate: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/aging-snapshot',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(body.buckets.length).toBe(4);
    expect(body.agingLevel).toBeDefined();
  });
});

describe('kyc completion gaps', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no kyc profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/completion-gaps',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('analyzes gaps with kyc profile', async () => {
    await ctx.prisma.kycProfile.create({
      data: { userId: ctx.user.id, level: 'basic', status: 'pending', nationality: 'US' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/completion-gaps',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.completionRate).toBeDefined();
    expect(body.gaps.length).toBe(6);
    expect(body.gapLevel).toBeDefined();
  });
});
