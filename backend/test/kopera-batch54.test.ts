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
    payload: { email: 'b54@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b54@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ledger balance volatility', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(0), status: 'ACTIVE', isDefault: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/balance-volatility`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.volatilityLevel).toBe('none');
    expect(body.largestSwing).toBeNull();
  });

  it('analyzes balance fluctuations', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000), status: 'ACTIVE', isDefault: true },
    });
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await ctx.prisma.ledgerEntry.create({
        data: {
          walletId: wallet.id, transactionId: `txn-${i}`, entryType: i % 2 === 0 ? 'CREDIT' : 'DEBIT',
          amount: BigInt(10000 + i * 5000), balanceBefore: BigInt(30000 + i * 2000),
          balanceAfter: BigInt(40000 + i * 3000), currency: 'USD',
          createdAt: new Date(now + i * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/balance-volatility`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(4);
    expect(body.volatilityLevel).toBeDefined();
    expect(body.largestSwing).toBeDefined();
    expect(body.byDay.length).toBeGreaterThan(0);
    expect(body.coefficientOfVariation).toBeGreaterThanOrEqual(0);
  });
});

describe('loan repayment payment gap analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns insufficient data with fewer than 2 paid', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000), currency: 'USD',
        termMonths: 12, interestRate: 0.12, status: 'DISBURSED',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/payment-gap-analysis?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paidInstallments).toBe(0);
    expect(body.pattern).toBe('insufficient_data');
  });

  it('analyzes gaps between paid installments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000), currency: 'USD',
        termMonths: 12, interestRate: 0.12, status: 'DISBURSED',
      },
    });
    const now = Date.now();
    for (let i = 1; i <= 4; i++) {
      await ctx.prisma.loanRepayment.create({
        data: {
          loanId: loan.id, installment: i, amount: BigInt(9000),
          paidAmount: BigInt(9000), status: 'PAID',
          dueDate: new Date(now + i * 30 * 86400000),
          paidAt: new Date(now + i * 30 * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/payment-gap-analysis?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paidInstallments).toBe(4);
    expect(body.gaps.length).toBe(3);
    expect(body.avgGapDays).toBeGreaterThan(0);
    expect(['regular', 'mostly_regular', 'irregular']).toContain(body.pattern);
  });
});

describe('loans maturity timeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no active loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/maturity-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveLoans).toBe(0);
    expect(body.upcomingMaturities).toBeInstanceOf(Array);
    expect(body.nearestMaturity).toBeNull();
    expect(body.concentrationRisk).toBe('none');
  });

  it('computes maturity dates for active loans', async () => {
    for (let i = 0; i < 2; i++) {
      await ctx.prisma.loan.create({
        data: {
          userId: ctx.user.id, principalAmount: BigInt(50000 + i * 10000), currency: 'USD',
          termMonths: 6 + i * 6, interestRate: 0.12, status: 'DISBURSED',
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/maturity-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveLoans).toBe(2);
    expect(body.upcomingMaturities.length).toBeGreaterThan(0);
    expect(body.nearestMaturity).toBeDefined();
    expect(body.nearestMaturity.daysRemaining).toBeGreaterThanOrEqual(0);
    expect(['low', 'moderate', 'high']).toContain(body.concentrationRisk);
  });
});

describe('notifications type effectiveness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/type-effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.byType).toBeInstanceOf(Array);
    expect(body.bestType).toBeNull();
  });

  it('ranks types by effectiveness', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.notification.create({
        data: {
          userId: ctx.user.id, type: 'PAYMENT', channel: 'email',
          title: `Payment ${i}`, body: 'test',
          sentAt: new Date(now + i * 60000),
          deliveredAt: new Date(now + i * 60000 + 5000),
          readAt: i < 2 ? new Date(now + i * 60000 + 30000) : null,
        },
      });
    }
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'SECURITY', channel: 'push',
        title: 'Security alert', body: 'test',
        sentAt: new Date(now + 200000),
        deliveredAt: new Date(now + 205000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/type-effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(4);
    expect(body.byType.length).toBe(2);
    expect(body.bestType).toBeDefined();
    expect(body.byType[0].effectivenessScore).toBeGreaterThan(0);
  });
});

describe('payment links usage velocity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/usage-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.adoptionTrend).toBe('none');
    expect(body.peakDay).toBeNull();
  });

  it('tracks creation and usage velocity', async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await ctx.prisma.paymentLink.create({
        data: {
          userId: ctx.user.id, code: `LINK${i}`, amount: BigInt(5000 + i * 1000),
          currency: 'USD', status: 'active', timesUsed: i,
          lastUsedAt: i > 0 ? new Date(now + i * 86400000) : null,
          createdAt: new Date(now + i * 86400000),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/usage-velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(4);
    expect(body.totalUsed).toBe(6);
    expect(body.byDay.length).toBeGreaterThan(0);
    expect(body.avgCreatedPerWeek).toBeGreaterThan(0);
    expect(body.peakDay).toBeDefined();
  });
});
