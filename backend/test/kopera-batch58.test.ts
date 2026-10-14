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
    payload: { email: 'b58@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b58@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('disputes response time analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/response-time-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.resolvedCount).toBe(0);
    expect(body.avgResponseDays).toBe(0);
  });

  it('analyzes resolution response times', async () => {
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'txn-d1', reason: 'fraud',
        amount: BigInt(10000), currency: 'USD', status: 'WON',
        createdAt: new Date(Date.now() - 20 * 86400000),
        resolvedAt: new Date(Date.now() - 5 * 86400000),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'txn-d2', reason: 'unauthorized',
        amount: BigInt(5000), currency: 'USD', status: 'LOST',
        createdAt: new Date(Date.now() - 50 * 86400000),
        resolvedAt: new Date(Date.now() - 10 * 86400000),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: 'txn-d3', reason: 'fraud',
        amount: BigInt(8000), currency: 'USD', status: 'OPEN',
        createdAt: new Date(Date.now() - 3 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/response-time-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(3);
    expect(body.resolvedCount).toBe(2);
    expect(body.avgResponseDays).toBeGreaterThan(0);
    expect(body.bySpeed.length).toBeGreaterThan(0);
    expect(body.slaCompliance).toBeGreaterThanOrEqual(0);
  });
});

describe('events heatmap', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns heatmap structure with baseline events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/heatmap',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.byDayOfWeek).toBeInstanceOf(Array);
    expect(body.byHour).toBeInstanceOf(Array);
    expect(body.weekdayVsWeekend).toBeDefined();
  });

  it('distributes events by day and hour', async () => {
    const baseRes = await ctx.app.inject({
      method: 'GET', url: '/api/events/heatmap',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const baseCount = baseRes.json().totalEvents;

    for (let i = 0; i < 10; i++) {
      const d = new Date(2025, 5, 9 + (i % 3), 10 + (i % 5));
      await ctx.prisma.event.create({
        data: {
          userId: ctx.user.id, eventType: `action.${i}`, channel: 'web',
          createdAt: d,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/heatmap',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBe(baseCount + 10);
    expect(body.byDayOfWeek.length).toBe(7);
    expect(body.byHour.length).toBe(24);
    expect(body.peakDay).toBeDefined();
    expect(body.peakHour).toBeDefined();
    expect(body.weekdayVsWeekend.weekday + body.weekdayVsWeekend.weekend).toBe(baseCount + 10);
  });
});

describe('fx rate volatility report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/rate-volatility',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.pairs).toBeInstanceOf(Array);
    expect(body.mostVolatile).toBeNull();
  });

  it('analyzes rate volatility across pairs', async () => {
    const amounts = [10000, 15000, 12000, 50000, 8000];
    for (let i = 0; i < amounts.length; i++) {
      await ctx.prisma.transaction.create({
        data: {
          userId: ctx.user.id, type: 'FX_CONVERSION', amount: BigInt(amounts[i]),
          fee: BigInt(100), currency: 'USD', status: 'COMPLETED',
          reference: `fx-vol-${i}`, fxPair: 'USD-PEN',
          createdAt: new Date(Date.now() - (10 - i) * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/rate-volatility',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(5);
    expect(body.pairs.length).toBe(1);
    expect(body.pairs[0].pair).toBe('USD-PEN');
    expect(body.pairs[0].conversions).toBe(5);
    expect(body.mostVolatile).toBeDefined();
    expect(body.overallVolatility).toBeDefined();
  });
});

describe('gateway failure analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/failure-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.failedCount).toBe(0);
    expect(body.failureRate).toBe(0);
  });

  it('analyzes payment failure patterns', async () => {
    const txn1 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'PAYMENT', amount: BigInt(20000),
        fee: BigInt(200), currency: 'USD', status: 'COMPLETED', reference: 'gw-f1',
      },
    });
    const txn2 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'PAYMENT', amount: BigInt(15000),
        fee: BigInt(150), currency: 'USD', status: 'FAILED', reference: 'gw-f2',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn1.id, provider: 'stripe', externalId: 'ext1',
        paymentMethod: 'card', amount: BigInt(20000), currency: 'USD',
        status: 'COMPLETED',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn2.id, provider: 'stripe', externalId: 'ext2',
        paymentMethod: 'card', amount: BigInt(15000), currency: 'USD',
        status: 'FAILED', failureReason: 'insufficient_funds',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/failure-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(2);
    expect(body.failedCount).toBe(1);
    expect(body.failureRate).toBe(50);
    expect(body.byReason.length).toBe(1);
    expect(body.byReason[0].reason).toBe('insufficient_funds');
    expect(body.byMethod.length).toBeGreaterThan(0);
  });
});

describe('invoices payment behavior analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/payment-behavior',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.paidCount).toBe(0);
    expect(body.overdueAmount).toBe('0');
  });

  it('analyzes payment speed and behavior', async () => {
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, receiverEmail: 'client1@test.com',
        invoiceNumber: 'INV-PB001', series: 'F', number: 1,
        totalAmount: BigInt(50000), subtotal: BigInt(42000), taxAmount: BigInt(8000),
        currency: 'USD', status: 'PAID',
        dueDate: new Date(Date.now() + 30 * 86400000),
        createdAt: new Date(Date.now() - 20 * 86400000),
        paidAt: new Date(Date.now() - 10 * 86400000),
      },
    });
    await ctx.prisma.invoice.create({
      data: {
        senderId: ctx.user.id, receiverEmail: 'client2@test.com',
        invoiceNumber: 'INV-PB002', series: 'F', number: 2,
        totalAmount: BigInt(30000), subtotal: BigInt(25000), taxAmount: BigInt(5000),
        currency: 'USD', status: 'SENT',
        dueDate: new Date(Date.now() - 5 * 86400000),
        createdAt: new Date(Date.now() - 40 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/payment-behavior',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(body.paidCount).toBe(1);
    expect(body.unpaidCount).toBe(1);
    expect(body.avgDaysToPay).toBeGreaterThan(0);
    expect(body.byPaymentSpeed.length).toBeGreaterThan(0);
    expect(Number(body.overdueAmount)).toBeGreaterThan(0);
  });
});
