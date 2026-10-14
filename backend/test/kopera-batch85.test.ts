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
    payload: { email: 'b85@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b85@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ledger balance validation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data for empty wallet ledger', async () => {
    const w = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${w.id}/balance-validation`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.validationLevel).toBe('no_data');
  });

  it('validates ledger entries and detects issues', async () => {
    const w = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(5000) },
    });
    await ctx.prisma.ledgerEntry.create({
      data: { walletId: w.id, type: 'credit', amount: BigInt(5000), reference: 'REF1' },
    });
    await ctx.prisma.ledgerEntry.create({
      data: { walletId: w.id, type: 'debit', amount: BigInt(8000), reference: 'REF2' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${w.id}/balance-validation`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(2);
    expect(body.validationScore).toBeDefined();
    expect(body.finalBalance).toBeDefined();
    expect(body.issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe('repayment completion forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data for loan with no repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(100000), currency: 'USD', termMonths: 12, interestRate: 10, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/completion-forecast?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(0);
    expect(body.forecastLevel).toBe('no_data');
  });

  it('forecasts completion with paid repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(120000), currency: 'USD', termMonths: 12, interestRate: 10, status: 'ACTIVE' },
    });
    const now = Date.now();
    await ctx.prisma.loanRepayment.create({
      data: { loanId: loan.id, amount: BigInt(10000), dueDate: new Date(now - 60 * 86400000), paidAmount: BigInt(10000), paidAt: new Date(now - 58 * 86400000), status: 'PAID' },
    });
    await ctx.prisma.loanRepayment.create({
      data: { loanId: loan.id, amount: BigInt(10000), dueDate: new Date(now - 30 * 86400000), paidAmount: BigInt(10000), paidAt: new Date(now - 28 * 86400000), status: 'PAID' },
    });
    await ctx.prisma.loanRepayment.create({
      data: { loanId: loan.id, amount: BigInt(10000), dueDate: new Date(now + 30 * 86400000), paidAmount: BigInt(0), paidAt: null, status: 'PENDING' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/completion-forecast?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(3);
    expect(body.paidCount).toBe(2);
    expect(body.completionRate).toBeGreaterThan(0);
    expect(body.forecastLevel).toBeDefined();
    expect(body.totalDue).toBeDefined();
    expect(body.totalPaid).toBeDefined();
  });
});

describe('loan payment burden', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/payment-burden',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(0);
    expect(body.burdenLevel).toBe('no_data');
  });

  it('calculates burden with active loans', async () => {
    await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(600000), currency: 'USD', termMonths: 12, interestRate: 10, status: 'ACTIVE' },
    });
    await ctx.prisma.loan.create({
      data: { userId: ctx.user.id, amount: BigInt(300000), currency: 'USD', termMonths: 6, interestRate: 15, status: 'OVERDUE' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/payment-burden',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(2);
    expect(body.activeLoans).toBe(1);
    expect(body.overdueCount).toBe(1);
    expect(body.burdenScore).toBeGreaterThan(0);
    expect(body.monthlyObligation).toBeDefined();
    expect(body.totalOutstanding).toBeDefined();
  });
});

describe('notification delivery health', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/delivery-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.deliveryLevel).toBe('no_data');
  });

  it('analyzes delivery health with mixed statuses', async () => {
    await ctx.prisma.notification.create({
      data: { userId: ctx.user.id, type: 'transfer', title: 'N1', body: 'Body', status: 'delivered' },
    });
    await ctx.prisma.notification.create({
      data: { userId: ctx.user.id, type: 'alert', title: 'N2', body: 'Body', status: 'failed' },
    });
    await ctx.prisma.notification.create({
      data: { userId: ctx.user.id, type: 'info', title: 'N3', body: 'Body', status: 'delivered' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/delivery-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(3);
    expect(body.deliveryRate).toBeGreaterThan(0);
    expect(body.breakdown.delivered).toBe(2);
    expect(body.breakdown.failed).toBe(1);
    expect(body.deliveryLevel).toBeDefined();
  });
});

describe('payment link expiry analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no payment links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/expiry-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.expiryLevel).toBe('no_data');
  });

  it('analyzes expiry with mixed link statuses', async () => {
    const now = Date.now();
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, amount: BigInt(5000), currency: 'USD', code: 'PL85A', status: 'active', expiresAt: new Date(now + 30 * 86400000) },
    });
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, amount: BigInt(3000), currency: 'USD', code: 'PL85B', status: 'expired', expiresAt: new Date(now - 5 * 86400000) },
    });
    await ctx.prisma.paymentLink.create({
      data: { userId: ctx.user.id, amount: BigInt(2000), currency: 'USD', code: 'PL85C', status: 'active', expiresAt: new Date(now + 3 * 86400000) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/expiry-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(3);
    expect(body.breakdown.expired).toBeGreaterThanOrEqual(1);
    expect(body.breakdown.expiringSoon).toBeGreaterThanOrEqual(1);
    expect(body.expiryLevel).toBeDefined();
    expect(body.expiryScore).toBeGreaterThan(0);
  });
});
