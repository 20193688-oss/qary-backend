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
    payload: { email: 'b74@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b74@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kyc document integrity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no kyc profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/document-integrity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('checks document integrity', async () => {
    await ctx.prisma.kycProfile.create({
      data: {
        userId: ctx.user.id,
        documentType: 'passport',
        documentNumber: 'AB123456',
        documentFrontUrl: 'https://example.com/front.jpg',
        selfieUrl: 'https://example.com/selfie.jpg',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/document-integrity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(body.integrityScore).toBeGreaterThan(0);
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.integrityLevel).toBeDefined();
  });
});

describe('ledger audit trail', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(0) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/audit-trail`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.auditScore).toBe(100);
    expect(body.auditLevel).toBe('no_data');
  });

  it('generates audit trail', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(10000) },
    });
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, type: 'CREDIT', amount: BigInt(5000),
        balance: BigInt(5000), description: 'Deposit',
      },
    });
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, type: 'DEBIT', amount: BigInt(-2000),
        balance: BigInt(3000), description: 'Payment',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/audit-trail`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(2);
    expect(body.dateRange).toBeDefined();
    expect(body.auditScore).toBeLessThanOrEqual(100);
    expect(body.auditLevel).toBeDefined();
  });
});

describe('repayment efficiency score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, amount: BigInt(100000), currency: 'USD',
        termMonths: 12, interestRate: 10, status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/efficiency-score?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(0);
    expect(body.efficiencyScore).toBe(100);
    expect(body.efficiencyLevel).toBe('no_data');
  });

  it('calculates efficiency score', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, amount: BigInt(100000), currency: 'USD',
        termMonths: 12, interestRate: 10, status: 'active',
      },
    });
    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, amount: BigInt(10000),
        dueDate: new Date(Date.now() - 5 * 86400000),
        paidAt: new Date(Date.now() - 8 * 86400000),
        status: 'paid',
      },
    });
    await ctx.prisma.loanRepayment.create({
      data: {
        loanId: loan.id, amount: BigInt(10000),
        dueDate: new Date(Date.now() + 5 * 86400000),
        status: 'PENDING',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/efficiency-score?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(2);
    expect(body.efficiencyScore).toBeLessThanOrEqual(100);
    expect(body.efficiencyLevel).toBeDefined();
    expect(body.onTimeRate).toBeGreaterThan(0);
  });
});

describe('loan affordability check', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/affordability-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(0);
    expect(body.affordabilityScore).toBe(100);
    expect(body.affordabilityLevel).toBe('no_data');
  });

  it('checks loan affordability', async () => {
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, amount: BigInt(500000), currency: 'USD',
        termMonths: 24, interestRate: 12, status: 'active',
      },
    });
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, amount: BigInt(200000), currency: 'USD',
        termMonths: 12, interestRate: 8, status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/affordability-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(2);
    expect(body.activeLoans).toBe(2);
    expect(Number(body.totalDebt)).toBeGreaterThan(0);
    expect(body.affordabilityScore).toBeLessThanOrEqual(100);
    expect(body.affordabilityLevel).toBeDefined();
  });
});

describe('notification response metrics', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/response-metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.readRate).toBe(0);
    expect(body.responseLevel).toBe('no_data');
  });

  it('calculates response metrics', async () => {
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'info',
        title: 'Welcome', message: 'Hello',
        readAt: new Date(),
      },
    });
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'alert',
        title: 'Payment', message: 'Payment received',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/response-metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(2);
    expect(body.readCount).toBe(1);
    expect(body.unreadCount).toBe(1);
    expect(body.readRate).toBe(50);
    expect(body.responseLevel).toBe('moderate');
    expect(body.byChannel.length).toBeGreaterThan(0);
  });
});
