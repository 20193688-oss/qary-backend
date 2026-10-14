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
    payload: { email: 'b69@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b69@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kyc compliance timeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no kyc profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/compliance-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns compliance timeline', async () => {
    await ctx.prisma.kycProfile.create({
      data: {
        userId: ctx.user.id, status: 'PENDING',
        documentFrontUrl: 'https://example.com/front.jpg',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/compliance-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(body.currentStatus).toBe('PENDING');
    expect(body.totalSteps).toBeGreaterThan(0);
    expect(body.completedSteps).toBeGreaterThan(0);
    expect(body.timeline.length).toBeGreaterThan(0);
    expect(body.progress).toBeGreaterThan(0);
  });
});

describe('ledger category breakdown', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/category-breakdown`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.totalCredits).toBe('0');
  });

  it('breaks down ledger by category', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.ledgerEntry.create({
      data: { walletId: wallet.id, type: 'CREDIT', amount: BigInt(5000), balance: BigInt(5000) },
    });
    await ctx.prisma.ledgerEntry.create({
      data: { walletId: wallet.id, type: 'DEBIT', amount: BigInt(2000), balance: BigInt(3000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/category-breakdown`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(2);
    expect(Object.keys(body.byType).length).toBeGreaterThan(0);
    expect(body.largestEntry).toBeDefined();
  });
});

describe('repayment risk profile', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000),
        currency: 'USD', termMonths: 12, interestRate: 10, status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/risk-profile?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(0);
    expect(body.riskLevel).toBe('none');
  });

  it('calculates repayment risk', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000),
        currency: 'USD', termMonths: 12, interestRate: 10, status: 'active',
      },
    });
    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, amount: BigInt(10000), status: 'paid',
        dueDate: new Date(Date.now() - 28 * 86400000),
        paidAt: new Date(Date.now() - 29 * 86400000),
      },
    });
    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, amount: BigInt(10000), status: 'overdue',
        dueDate: new Date(Date.now() - 5 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/risk-profile?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(2);
    expect(body.riskScore).toBeGreaterThan(0);
    expect(body.missedCount).toBe(1);
    expect(body.onTimeCount).toBe(1);
  });
});

describe('loan consolidation analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no active loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/consolidation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveLoans).toBe(0);
    expect(body.canConsolidate).toBe(false);
  });

  it('analyzes consolidation opportunities', async () => {
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(50000),
        currency: 'USD', termMonths: 12, interestRate: 15, status: 'active',
      },
    });
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(30000),
        currency: 'USD', termMonths: 6, interestRate: 20, status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/consolidation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveLoans).toBe(2);
    expect(body.canConsolidate).toBe(true);
    expect(body.weightedAvgRate).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});

describe('notification priority analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/priority-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.highPriorityUnread).toBe(0);
  });

  it('analyzes notification priorities', async () => {
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'high', channel: 'push',
        title: 'Urgent alert', body: 'Action needed',
      },
    });
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'normal', channel: 'email',
        title: 'Update', body: 'Info',
        readAt: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/priority-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(2);
    expect(Object.keys(body.byPriority).length).toBeGreaterThan(0);
    expect(body.highPriorityUnread).toBe(1);
  });
});
