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
    payload: { email: 'b63@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b63@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('disputes outcome predictor', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/outcome-predictor',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.winRate).toBe(0);
    expect(body.predictedOutcome).toBeNull();
  });

  it('predicts dispute outcomes based on history', async () => {
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'tx-1', reason: 'fraud',
        amount: BigInt(5000), currency: 'USD', status: 'won',
        category: 'fraud',
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'tx-2', reason: 'billing_error',
        amount: BigInt(2000), currency: 'USD', status: 'won',
        category: 'billing',
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'tx-3', reason: 'fraud',
        amount: BigInt(3000), currency: 'USD', status: 'open',
        category: 'fraud',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/outcome-predictor',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(3);
    expect(body.resolvedCount).toBe(2);
    expect(body.winRate).toBe(100);
    expect(body.byCategory.length).toBeGreaterThanOrEqual(1);
    expect(body.predictedOutcome).toBe('likely_favorable');
  });
});

describe('events correlation analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with insufficient events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/sequence-correlation',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.correlations).toEqual([]);
    expect(body.topSequence).toBeNull();
  });

  it('analyzes event correlations', async () => {
    const baseTime = new Date(2025, 5, 10, 10, 0).getTime();
    const types = ['auth.login', 'profile.view', 'auth.login', 'profile.view', 'auth.login', 'profile.view'];
    for (let i = 0; i < types.length; i++) {
      await ctx.prisma.event.create({
        data: {
          userId: ctx.user.id, eventType: types[i],
          actor: 'user', payload: {},
          createdAt: new Date(baseTime + i * 60000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/sequence-correlation',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(6);
    expect(body.correlations.length).toBeGreaterThan(0);
    expect(body.topSequence).toBeDefined();
    expect(body.avgTimeBetweenEvents).toBeDefined();
  });
});

describe('fx currency exposure summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/exposure-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.uniqueCurrencies).toBe(0);
    expect(body.largestExposure).toBeNull();
  });

  it('summarizes currency exposure', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        type: 'FX_CONVERSION', amount: BigInt(10000), currency: 'USD',
        status: 'COMPLETED', reference: 'fx-1',
        counterpartyCurrency: 'EUR', toAmount: BigInt(9200),
      },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        type: 'FX_CONVERSION', amount: BigInt(5000), currency: 'USD',
        status: 'COMPLETED', reference: 'fx-2',
        counterpartyCurrency: 'GBP', toAmount: BigInt(3900),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/exposure-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(2);
    expect(body.uniqueCurrencies).toBeGreaterThanOrEqual(2);
    expect(body.byCurrency.length).toBeGreaterThanOrEqual(2);
    expect(body.largestExposure).toBeDefined();
    expect(body.diversificationScore).toBeGreaterThanOrEqual(0);
  });
});

describe('gateway provider performance benchmark', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/provider-benchmark',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.providers).toEqual([]);
    expect(body.bestProvider).toBeNull();
  });

  it('benchmarks provider performance', async () => {
    await ctx.prisma.gatewayPayment.create({
      data: {
        userId: ctx.user.id, provider: 'stripe',
        amount: BigInt(5000), currency: 'USD', status: 'completed',
        externalId: 'ext-1',
        processedAt: new Date(Date.now() + 2000),
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        userId: ctx.user.id, provider: 'stripe',
        amount: BigInt(3000), currency: 'USD', status: 'completed',
        externalId: 'ext-2',
        processedAt: new Date(Date.now() + 1500),
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        userId: ctx.user.id, provider: 'paypal',
        amount: BigInt(2000), currency: 'USD', status: 'failed',
        externalId: 'ext-3',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/provider-benchmark',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(3);
    expect(body.providers.length).toBe(2);
    expect(body.bestProvider).toBeDefined();
  });
});

describe('invoices revenue concentration analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/revenue-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.totalRevenue).toBe('0');
    expect(body.concentrationRisk).toBe('none');
  });

  it('analyzes revenue concentration by client', async () => {
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, recipientEmail: 'client-a@test.com',
        invoiceNumber: 'INV-001', totalAmount: BigInt(100000),
        currency: 'USD', status: 'paid',
      },
    });
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, recipientEmail: 'client-a@test.com',
        invoiceNumber: 'INV-002', totalAmount: BigInt(50000),
        currency: 'USD', status: 'paid',
      },
    });
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, recipientEmail: 'client-b@test.com',
        invoiceNumber: 'INV-003', totalAmount: BigInt(30000),
        currency: 'USD', status: 'sent',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/revenue-concentration',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(3);
    expect(body.uniqueClients).toBe(2);
    expect(body.byClient.length).toBe(2);
    expect(body.concentrationRisk).toBeDefined();
    expect(body.herfindahlIndex).toBeGreaterThan(0);
  });
});
