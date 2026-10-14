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
    payload: { email: 'b73@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b73@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('dispute resolution efficiency', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/resolution-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.efficiencyScore).toBe(100);
    expect(body.efficiencyLevel).toBe('no_data');
  });

  it('analyzes resolution efficiency', async () => {
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'txn1', reason: 'fraud',
        status: 'resolved', amount: BigInt(5000),
        resolvedAt: new Date(),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'txn2', reason: 'error',
        status: 'open', amount: BigInt(3000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/resolution-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(2);
    expect(body.resolvedCount).toBe(1);
    expect(body.resolutionRate).toBeGreaterThan(0);
    expect(body.efficiencyLevel).toBeDefined();
  });
});

describe('event burst detection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns burst detection results', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/burst-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(0);
    expect(body.anomalyCount).toBeGreaterThanOrEqual(0);
    expect(body.riskLevel).toBeDefined();
  });

  it('detects bursts in events', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.event.create({
        data: {
          userId: ctx.user.id, eventType: 'login',
          payload: {}, createdAt: new Date(Date.now() - i * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/burst-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThan(0);
    expect(body.anomalyRate).toBeDefined();
    expect(body.riskLevel).toBeDefined();
  });
});

describe('fx cost optimization', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/cost-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.totalFeePaid).toBe('0');
    expect(body.optimizationScore).toBe(100);
  });

  it('analyzes cost optimization', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000) },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        type: 'FX_CONVERSION', amount: BigInt(10000),
        currency: 'USD', status: 'completed',
        feeAmount: BigInt(100),
      },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        type: 'FX_CONVERSION', amount: BigInt(20000),
        currency: 'USD', status: 'completed',
        feeAmount: BigInt(300),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/cost-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(2);
    expect(Number(body.totalFeePaid)).toBeGreaterThan(0);
    expect(body.costlyPairs.length).toBeGreaterThan(0);
    expect(body.optimizationScore).toBeLessThanOrEqual(100);
  });
});

describe('gateway reconciliation status', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/reconciliation-status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.reconciliationRate).toBe(100);
    expect(body.healthLevel).toBe('no_data');
  });

  it('checks reconciliation status', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000) },
    });
    const txn = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        type: 'payment', amount: BigInt(5000), currency: 'USD',
        status: 'completed',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn.id, provider: 'stripe',
        externalId: 'ext_1', status: 'settled',
        amount: BigInt(5000), currency: 'USD',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/reconciliation-status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(1);
    expect(body.reconciledCount).toBe(1);
    expect(body.reconciliationRate).toBe(100);
    expect(body.healthLevel).toBe('excellent');
  });
});

describe('invoice cashflow impact', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/cashflow-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.totalOutstanding).toBe('0');
    expect(body.cashflowHealth).toBe('no_data');
  });

  it('analyzes cashflow impact', async () => {
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, receiverId: 'recv1',
        amount: BigInt(10000), currency: 'USD',
        status: 'paid', dueDate: new Date(Date.now() + 30 * 86400000),
        paidAt: new Date(),
      },
    });
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, receiverId: 'recv2',
        amount: BigInt(5000), currency: 'USD',
        status: 'pending', dueDate: new Date(Date.now() + 60 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/cashflow-impact',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(Number(body.totalPaid)).toBeGreaterThan(0);
    expect(Number(body.totalOutstanding)).toBeGreaterThan(0);
    expect(body.cashflowHealth).toBeDefined();
    expect(body.cashflowScore).toBeLessThanOrEqual(100);
  });
});
