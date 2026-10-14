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
    payload: { email: 'b64@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b64@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kyc risk scoring', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no KYC record', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/risk-scoring',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('scores KYC risk based on verification status', async () => {
    await ctx.prisma.kycProfile.create({
      data: {
        userId: ctx.user.id,
        status: 'approved',
        documentType: 'passport',
        documentNumber: 'AB123456',
        documentCountry: 'US',
        selfieUrl: 'https://example.com/selfie.jpg',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/risk-scoring',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.riskScore).toBeDefined();
    expect(body.riskLevel).toBeDefined();
    expect(body.factors.length).toBeGreaterThan(0);
    expect(body.status).toBe('approved');
    expect(body.riskScore).toBeLessThan(50);
  });
});

describe('ledger balance trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no ledger entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/balance-trend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.currentBalance).toBe('0');
    expect(body.trend).toBe('flat');
  });

  it('tracks balance trend over time', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, direction: 'CREDIT', amount: BigInt(10000),
        currency: 'USD', balance: BigInt(10000),
        createdAt: new Date(2025, 5, 1),
      },
    });
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, direction: 'DEBIT', amount: BigInt(3000),
        currency: 'USD', balance: BigInt(7000),
        createdAt: new Date(2025, 5, 5),
      },
    });
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, direction: 'CREDIT', amount: BigInt(15000),
        currency: 'USD', balance: BigInt(22000),
        createdAt: new Date(2025, 5, 10),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/balance-trend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(3);
    expect(body.dataPoints.length).toBeGreaterThanOrEqual(1);
    expect(body.trend).toBe('growing');
    expect(BigInt(body.currentBalance)).toBe(BigInt(22000));
  });
});

describe('loan repayment projection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty projection with no repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000),
        currency: 'USD', termMonths: 12, interestRate: 12,
        status: 'active',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/projection?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(0);
    expect(body.totalPaid).toBe('0');
  });

  it('projects repayments based on history', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000),
        currency: 'USD', termMonths: 12, interestRate: 12,
        status: 'active',
      },
    });
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.loanRepayment.create({
        data: {
          loanId: loan.id, amount: BigInt(9000),
          principalPortion: BigInt(7500), interestPortion: BigInt(1500),
          status: 'completed',
          createdAt: new Date(2025, 3 + i, 15),
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/projection?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRepayments).toBe(3);
    expect(BigInt(body.totalPaid)).toBe(BigInt(27000));
    expect(body.avgPaymentAmount).toBeDefined();
    expect(body.paymentConsistency).toBeGreaterThan(0);
    expect(body.recentPayments.length).toBe(3);
  });
});

describe('loans portfolio risk', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/portfolio-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(0);
    expect(body.riskLevel).toBe('none');
  });

  it('assesses portfolio risk across loans', async () => {
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(50000),
        currency: 'USD', termMonths: 12, interestRate: 10,
        status: 'active',
      },
    });
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(30000),
        currency: 'EUR', termMonths: 6, interestRate: 15,
        status: 'overdue',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/portfolio-risk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(2);
    expect(body.riskScore).toBeGreaterThan(0);
    expect(body.riskLevel).toBeDefined();
    expect(body.byRisk.length).toBe(2);
    expect(body.diversification).toBeGreaterThan(0);
  });
});

describe('notifications engagement report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/engagement-analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.readRate).toBe(0);
  });

  it('analyzes notification engagement', async () => {
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, title: 'Welcome',
        body: 'Welcome to Kopera', channel: 'in_app',
        readAt: new Date(Date.now() - 3600000),
      },
    });
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, title: 'Transaction',
        body: 'Payment received', channel: 'push',
        readAt: new Date(Date.now() - 1800000),
      },
    });
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, title: 'Alert',
        body: 'Security alert', channel: 'in_app',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/engagement-analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(3);
    expect(body.readCount).toBe(2);
    expect(body.unreadCount).toBe(1);
    expect(body.readRate).toBeGreaterThan(0);
    expect(body.byChannel.length).toBe(2);
  });
});
