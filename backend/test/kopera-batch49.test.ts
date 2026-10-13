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
    payload: { email: 'b49@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b49@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ledger velocity trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns stable with no entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(10000), status: 'ACTIVE', isDefault: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/velocity-trend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.avgPerDay).toBe(0);
    expect(body.peakDay).toBeNull();
    expect(body.trend).toBe('stable');
  });

  it('computes velocity from ledger entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000), status: 'ACTIVE', isDefault: true },
    });

    const today = new Date();
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.ledgerEntry.create({
        data: {
          walletId: wallet.id, transactionId: `tx-vel-${i}`,
          amount: BigInt(1000), balanceBefore: BigInt(50000), balanceAfter: BigInt(51000),
          entryType: 'CREDIT', createdAt: today,
        },
      });
    }
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, transactionId: 'tx-vel-y',
        amount: BigInt(2000), balanceBefore: BigInt(50000), balanceAfter: BigInt(52000),
        entryType: 'CREDIT', createdAt: yesterday,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/velocity-trend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(6);
    expect(body.peakCount).toBe(5);
    expect(body.avgPerDay).toBeGreaterThan(0);
    expect(body.trend).toBeDefined();
  });
});

describe('loan repayments partial payment analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty for loan with no repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000), currency: 'USD',
        interestRate: 0.12, termMonths: 12, status: 'ACTIVE',
        outstandingBalance: BigInt(100000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loan.id}/partial-payment-analysis`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInstallments).toBe(0);
    expect(body.partialPayments).toBe(0);
    expect(body.cumulativeShortfall).toBe('0');
    expect(body.trend).toBe('none');
  });

  it('analyzes partial and full payments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000), currency: 'USD',
        interestRate: 0.12, termMonths: 12, status: 'ACTIVE',
        outstandingBalance: BigInt(80000),
      },
    });

    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, installment: 1, dueDate: new Date(),
        amount: BigInt(10000), principal: BigInt(8000), interest: BigInt(2000),
        paidAmount: BigInt(10000), paidAt: new Date(), status: 'PAID',
      },
    });
    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, installment: 2, dueDate: new Date(),
        amount: BigInt(10000), principal: BigInt(8200), interest: BigInt(1800),
        paidAmount: BigInt(5000), status: 'OVERDUE',
      },
    });
    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, installment: 3, dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        amount: BigInt(10000), principal: BigInt(8400), interest: BigInt(1600),
        paidAmount: BigInt(0), status: 'PENDING',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loan.id}/partial-payment-analysis`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInstallments).toBe(3);
    expect(body.fullPayments).toBe(1);
    expect(body.partialPayments).toBe(1);
    expect(body.unpaidCount).toBe(1);
    expect(body.cumulativeShortfall).toBe('15000');
    expect(body.installments.length).toBe(3);
    expect(body.installments[0].isPartial).toBe(false);
    expect(body.installments[1].isPartial).toBe(true);
  });
});

describe('loans interest cost analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zeros with no active loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/interest-cost-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(0);
    expect(body.totalPrincipal).toBe('0');
    expect(body.totalInterestCost).toBe('0');
    expect(body.weightedAvgRate).toBe(0);
    expect(body.byLoan).toBeInstanceOf(Array);
    expect(body.byLoan.length).toBe(0);
  });

  it('ranks loans by interest cost', async () => {
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(200000), currency: 'USD',
        interestRate: 0.15, termMonths: 24, status: 'ACTIVE',
        outstandingBalance: BigInt(180000), totalInterest: BigInt(30000),
      },
    });
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(50000), currency: 'USD',
        interestRate: 0.08, termMonths: 12, status: 'ACTIVE',
        outstandingBalance: BigInt(40000), totalInterest: BigInt(4000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/interest-cost-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(2);
    expect(body.totalPrincipal).toBe('250000');
    expect(body.totalInterestCost).toBe('34000');
    expect(body.weightedAvgRate).toBeGreaterThan(0);
    expect(body.interestToPrincipalRatio).toBeGreaterThan(0);
    expect(body.byLoan[0].costRank).toBe(1);
    expect(body.byLoan[0].interestCost).toBe('30000');
  });
});

describe('notifications fatigue', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns none with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/fatigue',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.fatigueLevel).toBe('none');
    expect(body.overallReadRate).toBe(0);
    expect(body.weeklyTrend).toBeInstanceOf(Array);
    expect(body.decliningTypes).toBeInstanceOf(Array);
  });

  it('detects fatigue from low read rates', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.notification.create({
        data: {
          userId: ctx.user.id, type: 'alert', channel: 'IN_APP',
          body: `Unread notification ${i}`,
        },
      });
    }
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'promo', channel: 'EMAIL',
        body: 'Read notification', readAt: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/fatigue',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(6);
    expect(body.overallReadRate).toBeLessThan(50);
    expect(body.fatigueLevel).toBe('high');
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('payment-links amount tier analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty tiers with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/amount-tier-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.tiers.micro.links).toBe(0);
    expect(body.tiers.small.links).toBe(0);
    expect(body.tiers.medium.links).toBe(0);
    expect(body.tiers.large.links).toBe(0);
    expect(body.bestPerformingTier).toBeNull();
  });

  it('categorizes links by amount tier', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5, currency: 'USD', description: 'Micro link' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD', description: 'Small link' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 500, currency: 'USD', description: 'Medium link' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/amount-tier-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(3);
    expect(body.tiers.micro.links).toBe(1);
    expect(body.tiers.small.links).toBe(1);
    expect(body.tiers.medium.links).toBe(1);
    expect(body.tiers.large.links).toBe(0);
  });
});
