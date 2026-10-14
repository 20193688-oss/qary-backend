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
    payload: { email: 'b53@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b53@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('events correlation analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with fewer than 2 events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/correlation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.correlatedPairs).toBeInstanceOf(Array);
    expect(body.topPattern).toBeNull();
  });

  it('finds correlated event pairs within time window', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.event.create({
        data: {
          userId: ctx.user.id, eventType: 'auth.login', actor: 'user',
          severity: 'info', payload: {}, createdAt: new Date(now + i * 60000),
        },
      });
      await ctx.prisma.event.create({
        data: {
          userId: ctx.user.id, eventType: 'wallet.check', actor: 'user',
          severity: 'info', payload: {}, createdAt: new Date(now + i * 60000 + 30000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/correlation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(6);
    expect(body.correlatedPairs.length).toBeGreaterThan(0);
    const loginToCheck = body.correlatedPairs.find((p: any) => p.pair === 'auth.login -> wallet.check');
    expect(loginToCheck).toBeDefined();
    expect(loginToCheck.occurrences).toBeGreaterThanOrEqual(2);
    expect(body.topPattern).toBeDefined();
  });
});

describe('fx conversion frequency report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-frequency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.monthlyBuckets).toBeInstanceOf(Array);
    expect(body.conversionStyle).toBe('none');
  });

  it('analyzes conversion frequency from transactions', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(100000), status: 'ACTIVE', isDefault: true },
    });
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.transaction.create({
        data: {
          userId: ctx.user.id, walletId: wallet.id, type: 'FX_CONVERSION',
          amount: BigInt(5000 + i * 1000), currency: 'USD', status: 'COMPLETED',
          description: `FX conversion ${i}`,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-frequency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(3);
    expect(body.monthlyBuckets.length).toBeGreaterThan(0);
    expect(body.peakMonth).toBeDefined();
    expect(['batched', 'irregular', 'spread']).toContain(body.conversionStyle);
  });
});

describe('gateway payment method trends', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payment-method-trends',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.monthlyTrends).toBeInstanceOf(Array);
    expect(body.diversityIndex).toBe(0);
  });

  it('tracks trends across payment methods', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(100000), status: 'ACTIVE', isDefault: true },
    });
    const txn1 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'PAYMENT',
        amount: BigInt(5000), currency: 'USD', status: 'COMPLETED', description: 'test1',
      },
    });
    const txn2 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'PAYMENT',
        amount: BigInt(3000), currency: 'USD', status: 'COMPLETED', description: 'test2',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn1.id, paymentMethod: 'CARD',
        amount: BigInt(5000), currency: 'USD', status: 'SETTLED',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn2.id, paymentMethod: 'BANK_TRANSFER',
        amount: BigInt(3000), currency: 'USD', status: 'SETTLED',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payment-method-trends',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(2);
    expect(body.methodShares.length).toBe(2);
    expect(body.diversityIndex).toBeGreaterThan(0);
  });
});

describe('invoice volume analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/volume-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.monthlyVolume).toBeInstanceOf(Array);
    expect(body.peakMonth).toBeNull();
  });

  it('analyzes invoice volume trends', async () => {
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.invoice.create({
        data: {
          senderId: ctx.user.id, receiverId: 'recv1',
          currency: 'USD', subtotal: BigInt(10000 + i * 5000),
          taxAmount: BigInt(1800), totalAmount: BigInt(11800 + i * 5000),
          status: i === 0 ? 'PAID' : 'SENT', country: 'US',
          type: 'FACTURA', number: `INV-${i}`,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/volume-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(3);
    expect(body.monthlyVolume.length).toBeGreaterThan(0);
    expect(body.peakMonth).toBeDefined();
    expect(body.currencyDistribution.length).toBe(1);
    expect(body.currencyDistribution[0].currency).toBe('USD');
  });
});

describe('kyc verification timeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns timeline for pending profile', async () => {
    await ctx.prisma.kycProfile.create({
      data: {
        userId: ctx.user.id, status: 'PENDING',
        documentType: 'PASSPORT', documentNumber: 'AB123456',
        documentCountry: 'US', firstName: 'Test', lastName: 'User',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/verification-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(body.currentStatus).toBe('PENDING');
    expect(body.transitions).toBeInstanceOf(Array);
    expect(body.transitions.length).toBeGreaterThanOrEqual(1);
    expect(body.systemAvgVerificationHours).toBeGreaterThanOrEqual(0);
  });

  it('shows stages for verified profile', async () => {
    const now = new Date();
    await ctx.prisma.kycProfile.create({
      data: {
        userId: ctx.user.id, status: 'APPROVED',
        documentType: 'PASSPORT', documentNumber: 'CD789012',
        documentCountry: 'US', firstName: 'Test', lastName: 'User',
        verifiedAt: now,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/verification-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentStatus).toBe('APPROVED');
    expect(body.transitions.length).toBe(2);
    expect(body.stages.length).toBe(1);
    expect(body.stages[0].from).toBe('CREATED');
    expect(body.stages[0].to).toBe('VERIFIED');
    expect(body.totalHours).toBeGreaterThanOrEqual(0);
  });
});
