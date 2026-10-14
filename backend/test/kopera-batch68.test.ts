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
    payload: { email: 'b68@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b68@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('dispute aging report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/aging-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.stalledCount).toBe(0);
  });

  it('calculates dispute aging', async () => {
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, type: 'chargeback', status: 'open',
        amount: BigInt(5000), currency: 'USD',
        createdAt: new Date(Date.now() - 45 * 86400000),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, type: 'chargeback', status: 'resolved',
        amount: BigInt(3000), currency: 'USD',
        resolvedAt: new Date(),
        createdAt: new Date(Date.now() - 5 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/aging-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(2);
    expect(body.avgAgeDays).toBeGreaterThan(0);
    expect(body.ageBuckets.length).toBeGreaterThan(0);
    expect(body.stalledCount).toBe(1);
  });
});

describe('event retention analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('handles baseline events from bootstrap', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/retention-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(0);
    expect(body.retentionRate).toBeGreaterThanOrEqual(0);
  });

  it('calculates retention with events', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.event.create({
        data: {
          userId: ctx.user.id, eventType: `test.action_${i}`,
          createdAt: new Date(Date.now() - i * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/retention-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThan(0);
    expect(body.activeDays).toBeGreaterThan(0);
    expect(body.longestStreak).toBeGreaterThan(0);
    expect(body.retentionRate).toBeGreaterThan(0);
  });
});

describe('fx conversion efficiency', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.efficiencyScore).toBe(100);
  });

  it('analyzes conversion efficiency', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.transaction.create({
        data: {
          userId: ctx.user.id, walletId: wallet.id,
          amount: BigInt(10000), currency: 'USD',
          type: 'FX_CONVERSION', status: 'completed',
          feeAmount: BigInt(100),
          reference: `fx-ref-${i}`,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-efficiency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(3);
    expect(BigInt(body.totalVolume)).toBeGreaterThan(BigInt(0));
    expect(body.efficiencyScore).toBeGreaterThan(0);
    expect(body.byMonth.length).toBeGreaterThan(0);
  });
});

describe('gateway payment conversion funnel', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/conversion-funnel',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.conversionRate).toBe(0);
  });

  it('analyzes payment funnel', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    const txn1 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        amount: BigInt(5000), currency: 'USD',
        type: 'PAYMENT', status: 'completed', reference: 'gw-ref-1',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn1.id, provider: 'stripe',
        externalId: 'ext_1', status: 'settled',
        amount: BigInt(5000), currency: 'USD',
        idempotencyKey: 'idem_1',
      },
    });
    const txn2 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id,
        amount: BigInt(3000), currency: 'USD',
        type: 'PAYMENT', status: 'failed', reference: 'gw-ref-2',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn2.id, provider: 'stripe',
        externalId: 'ext_2', status: 'failed',
        amount: BigInt(3000), currency: 'USD',
        idempotencyKey: 'idem_2',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/conversion-funnel',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(2);
    expect(body.initiated).toBe(2);
    expect(body.settled).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.conversionRate).toBe(50);
  });
});

describe('invoice dispute risk analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/dispute-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.riskLevel).toBe('none');
  });

  it('assesses invoice dispute risk', async () => {
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, receiverId: 'recv_1',
        invoiceNumber: 'INV-001', status: 'overdue',
        amount: BigInt(50000), currency: 'USD',
      },
    });
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, receiverId: 'recv_2',
        invoiceNumber: 'INV-002', status: 'paid',
        amount: BigInt(2000000), currency: 'USD',
        description: 'Consulting services',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/dispute-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(body.riskFactors.length).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(BigInt(body.totalAmount)).toBeGreaterThan(BigInt(0));
  });
});
