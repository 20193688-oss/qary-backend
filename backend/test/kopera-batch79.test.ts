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
    payload: { email: 'b79@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b79@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ledger reconciliation gaps', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(0) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/reconciliation-gaps`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.gapLevel).toBe('no_data');
  });

  it('detects gaps in ledger entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(10000) },
    });
    await ctx.prisma.ledgerEntry.create({
      data: { walletId: wallet.id, amount: BigInt(5000), type: 'CREDIT', description: 'deposit', createdAt: new Date(Date.now() - 90 * 86400000) },
    });
    await ctx.prisma.ledgerEntry.create({
      data: { walletId: wallet.id, amount: BigInt(3000), type: 'DEBIT', description: 'withdrawal', createdAt: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/reconciliation-gaps`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(2);
    expect(body.gapCount).toBeGreaterThan(0);
    expect(body.gapLevel).toBeDefined();
  });
});

describe('repayment behavior trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(100000), currency: 'USD', termMonths: 12, interestRate: 10, status: 'ACTIVE' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/behavior-trend?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(0);
    expect(body.trendDirection).toBe('no_data');
  });

  it('analyzes trend with repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(100000), currency: 'USD', termMonths: 12, interestRate: 10, status: 'ACTIVE' },
    });
    await ctx.prisma.loanRepayment.create({
      data: { loanId: loan.id, amount: BigInt(10000), paidAmount: BigInt(10000), currency: 'USD', status: 'PAID', dueDate: new Date() },
    });
    await ctx.prisma.loanRepayment.create({
      data: { loanId: loan.id, amount: BigInt(10000), paidAmount: BigInt(10000), currency: 'USD', status: 'PAID', dueDate: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/behavior-trend?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(2);
    expect(body.trendScore).toBeGreaterThan(0);
    expect(body.monthlyBreakdown.length).toBeGreaterThan(0);
  });
});

describe('loan concentration risk', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/concentration-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(0);
    expect(body.riskLevel).toBe('no_data');
  });

  it('calculates concentration with loans', async () => {
    await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(50000), currency: 'USD', termMonths: 12, interestRate: 10, status: 'ACTIVE' },
    });
    await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(30000), currency: 'USD', termMonths: 6, interestRate: 8, status: 'ACTIVE' },
    });
    await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(20000), currency: 'EUR', termMonths: 24, interestRate: 5, status: 'DISBURSED' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/concentration-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(3);
    expect(body.concentrationScore).toBeGreaterThan(0);
    expect(body.currencyBreakdown.length).toBe(2);
    expect(body.riskLevel).toBeDefined();
  });
});

describe('notification fatigue index', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/fatigue-index',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.fatigueLevel).toBe('no_data');
  });

  it('calculates fatigue with notifications', async () => {
    await ctx.prisma.notification.create({
      data: { userId: ctx.user.id, type: 'alert', title: 'Payment received', body: 'You got $50', readAt: new Date() },
    });
    await ctx.prisma.notification.create({
      data: { userId: ctx.user.id, type: 'alert', title: 'Transfer sent', body: 'You sent $30' },
    });
    await ctx.prisma.notification.create({
      data: { userId: ctx.user.id, type: 'promo', title: 'New feature', body: 'Check it out' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/fatigue-index',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(3);
    expect(body.fatigueScore).toBeGreaterThanOrEqual(0);
    expect(body.channelBreakdown.length).toBeGreaterThan(0);
    expect(body.fatigueLevel).toBeDefined();
  });
});

describe('payment link conversion funnel', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/conversion-funnel',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.funnelHealth).toBe('no_data');
  });

  it('analyzes funnel with links', async () => {
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, amount: BigInt(5000), currency: 'USD', status: 'completed', useCount: 1 },
    });
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, amount: BigInt(3000), currency: 'USD', status: 'active', useCount: 0 },
    });
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, amount: BigInt(2000), currency: 'USD', status: 'expired', useCount: 0 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/conversion-funnel',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(3);
    expect(body.stages).toBeDefined();
    expect(body.conversionRate).toBeGreaterThanOrEqual(0);
    expect(body.funnelHealth).toBeDefined();
  });
});
