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
    payload: { email: 'b45@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b45@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('bank-accounts rail distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty distribution with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/rail-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.byRail).toBeInstanceOf(Array);
    expect(body.byCountry).toBeInstanceOf(Array);
    expect(body.primaryRail).toBeNull();
    expect(body.diversificationScore).toBe(0);
  });

  it('analyzes distribution after adding accounts', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'BankA', accountNumber: '1111111111', rail: 'ACH', country: 'US', currency: 'USD', holderName: 'Test' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'BankB', accountNumber: '2222222222', rail: 'SEPA', country: 'DE', currency: 'EUR', holderName: 'Test' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/rail-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.byRail.length).toBe(2);
    expect(body.byCountry.length).toBe(2);
    expect(body.primaryRail).toBeDefined();
    expect(body.primaryCountry).toBeDefined();
    expect(body.diversificationScore).toBeGreaterThan(0);
  });
});

describe('business-profile onboarding timeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/onboarding-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('tracks onboarding after KYB registration', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyb/register',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxId: '20123456789', taxIdType: 'RUC', taxIdCountry: 'PE', legalRepName: 'Juan Perez', legalRepDocNumber: '12345678' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/onboarding-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSteps).toBe(5);
    expect(body.completedSteps).toBeGreaterThan(0);
    expect(body.progressPercent).toBeGreaterThan(0);
    expect(body.steps).toBeInstanceOf(Array);
    expect(body.steps.length).toBe(5);
    expect(body.currentStep).toBeDefined();
  });
});

describe('events velocity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns velocity based on existing auth events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(0);
    expect(body.eventsPerDay).toBeGreaterThanOrEqual(0);
    expect(body.byDayOfWeek).toBeDefined();
  });

  it('calculates velocity after logging additional events', async () => {
    const baseline = await ctx.prisma.event.findMany({ where: { userId: ctx.user.id } });
    const baseCount = baseline.length;

    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, actor: 'user', eventType: 'auth.login', payload: {} },
    });
    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, actor: 'system', eventType: 'wallet.created', payload: {} },
    });
    await ctx.prisma.event.create({
      data: { userId: ctx.user.id, actor: 'user', eventType: 'auth.login', payload: {} },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/velocity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBe(baseCount + 3);
    expect(body.eventsPerDay).toBeGreaterThan(0);
    expect(body.peakDay).toBeDefined();
    expect(body.peakHour).toBeDefined();
    expect(body.byDayOfWeek).toBeDefined();
    expect(body.trend).toBeDefined();
  });
});

describe('ledger entry distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty distribution for wallet with no entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(0), status: 'ACTIVE', isDefault: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/entry-distribution/${wallet.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.creditCount).toBe(0);
    expect(body.debitCount).toBe(0);
    expect(body.creditTotal).toBe('0');
  });

  it('analyzes distribution after ledger entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000), status: 'ACTIVE', isDefault: true },
    });

    await ctx.prisma.ledgerEntry.create({
      data: { walletId: wallet.id, transactionId: 'txn-1', amount: BigInt(50000), balanceBefore: BigInt(0), balanceAfter: BigInt(50000), entryType: 'CREDIT', description: 'Deposit' },
    });
    await ctx.prisma.ledgerEntry.create({
      data: { walletId: wallet.id, transactionId: 'txn-2', amount: BigInt(-10000), balanceBefore: BigInt(50000), balanceAfter: BigInt(40000), entryType: 'DEBIT', description: 'Withdrawal' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/entry-distribution/${wallet.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(2);
    expect(body.creditCount).toBe(1);
    expect(body.debitCount).toBe(1);
    expect(Number(body.creditTotal)).toBeGreaterThan(0);
    expect(Number(body.debitTotal)).toBeGreaterThan(0);
    expect(body.byMonth.length).toBeGreaterThan(0);
    expect(body.creditToDebitRatio).toBe(1);
  });
});

describe('loan-repayments payment punctuality', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data for loan with no paid installments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, status: 'DISBURSED', principalAmount: BigInt(100000),
        currency: 'USD', interestRate: 0.1, termMonths: 12,
        outstandingBalance: BigInt(100000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loan.id}/payment-punctuality`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paidInstallments).toBe(0);
    expect(body.rating).toBe('no_data');
    expect(body.punctualityScore).toBe(0);
  });

  it('calculates punctuality after payments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, status: 'DISBURSED', principalAmount: BigInt(100000),
        currency: 'USD', interestRate: 0.1, termMonths: 12,
        outstandingBalance: BigInt(80000),
      },
    });

    const pastDue = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const paidOnTime = new Date(pastDue.getTime() - 1000);

    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, installment: 1, dueDate: pastDue,
        amount: BigInt(10000), principal: BigInt(8000), interest: BigInt(2000),
        paidAmount: BigInt(10000), paidAt: paidOnTime, status: 'PAID',
      },
    });
    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, installment: 2, dueDate: pastDue,
        amount: BigInt(10000), principal: BigInt(8000), interest: BigInt(2000),
        paidAmount: BigInt(10000),
        paidAt: new Date(pastDue.getTime() + 5 * 24 * 60 * 60 * 1000),
        status: 'PAID',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loan.id}/payment-punctuality`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paidInstallments).toBe(2);
    expect(body.onTimeCount).toBe(1);
    expect(body.lateCount).toBe(1);
    expect(body.punctualityScore).toBe(50);
    expect(body.avgLateDays).toBeGreaterThan(0);
    expect(body.rating).toBeDefined();
    expect(body.latePayments.length).toBe(1);
  });
});
