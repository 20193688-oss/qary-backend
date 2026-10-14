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
    payload: { email: 'b59@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b59@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kyc document verification report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no kyc profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/document-verification-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('analyzes document verification patterns', async () => {
    await ctx.prisma.kycProfile.create({
      data: {
        userId: ctx.user.id, documentType: 'PASSPORT', documentNumber: 'P123',
        documentCountry: 'PE', firstName: 'Test', lastName: 'User', status: 'IN_REVIEW',
      },
    });
    await ctx.prisma.kycDocument.create({
      data: {
        userId: ctx.user.id, type: 'PASSPORT', documentType: 'PASSPORT',
        fileUrl: 'https://example.com/doc1.pdf', status: 'VERIFIED',
        createdAt: new Date(Date.now() - 10 * 86400000),
        updatedAt: new Date(Date.now() - 5 * 86400000),
      },
    });
    await ctx.prisma.kycDocument.create({
      data: {
        userId: ctx.user.id, type: 'SELFIE', documentType: 'SELFIE',
        fileUrl: 'https://example.com/doc2.pdf', status: 'PENDING',
        createdAt: new Date(Date.now() - 3 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/document-verification-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDocuments).toBe(2);
    expect(body.verified).toBe(1);
    expect(body.pending).toBe(1);
    expect(body.verificationRate).toBe(50);
    expect(body.byDocumentType.length).toBe(2);
  });
});

describe('ledger entry frequency analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no entries', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/entry-frequency`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(0);
    expect(body.peakDay).toBeNull();
    expect(body.activityPattern).toBe('none');
  });

  it('analyzes entry frequency per wallet', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    for (let i = 0; i < 8; i++) {
      const d = new Date(2025, 5, 9 + i, 12);
      await ctx.prisma.ledgerEntry.create({
        data: {
          walletId: wallet.id, transactionId: `txn-ef-${i}`,
          amount: BigInt(1000 * (i + 1)), balanceBefore: BigInt(i * 1000),
          balanceAfter: BigInt((i + 1) * 1000), entryType: 'CREDIT',
          createdAt: d,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${wallet.id}/entry-frequency`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntries).toBe(8);
    expect(body.avgEntriesPerDay).toBeGreaterThan(0);
    expect(body.peakDay).toBeDefined();
    expect(body.byDayOfWeek.length).toBe(7);
    expect(body.activityPattern).toBeDefined();
  });
});

describe('loan repayment streak analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no repayments', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000), currency: 'USD',
        termMonths: 12, interestRate: 0.12, status: 'DISBURSED',
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/streak-analysis?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInstallments).toBe(0);
    expect(body.currentStreak).toBe(0);
    expect(body.reliability).toBe('unknown');
  });

  it('tracks on-time payment streaks', async () => {
    const loan = await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(100000), currency: 'USD',
        termMonths: 12, interestRate: 0.12, status: 'DISBURSED',
      },
    });
    for (let i = 1; i <= 5; i++) {
      const dueDate = new Date(2025, i, 15);
      const paidAt = new Date(2025, i, 10 + i);
      await ctx.prisma.loanRepayment.create({
        data: {
          loanId: loan.id, installment: i,
          amount: BigInt(9000), principal: BigInt(7000), interest: BigInt(2000),
          status: 'PAID', dueDate, paidAt,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/streak-analysis?loanId=${loan.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInstallments).toBe(5);
    expect(body.onTimeCount).toBeGreaterThan(0);
    expect(body.longestStreak).toBeGreaterThan(0);
    expect(body.onTimeRate).toBeGreaterThan(0);
    expect(body.reliability).toBeDefined();
  });
});

describe('loans utilization report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/utilization-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(0);
    expect(body.totalApproved).toBe('0');
    expect(body.utilizationRate).toBe(0);
  });

  it('analyzes loan utilization across statuses', async () => {
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(50000), currency: 'USD',
        termMonths: 12, interestRate: 0.12, status: 'DISBURSED',
      },
    });
    await ctx.prisma.loan.create({
      data: {
        userId: ctx.user.id, principalAmount: BigInt(30000), currency: 'USD',
        termMonths: 6, interestRate: 0.10, status: 'APPROVED',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/utilization-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLoans).toBe(2);
    expect(body.disbursed).toBe(1);
    expect(Number(body.totalApproved)).toBeGreaterThan(0);
    expect(body.utilizationRate).toBeGreaterThan(0);
    expect(body.byStatus.length).toBe(2);
    expect(body.byCurrency.length).toBe(1);
  });
});

describe('notifications delivery latency report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/delivery-latency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.deliveredCount).toBe(0);
    expect(body.avgLatencyMs).toBe(0);
  });

  it('analyzes delivery latency patterns', async () => {
    const now = Date.now();
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'TRANSACTION', channel: 'push',
        body: 'Payment received', sentAt: new Date(now - 60000),
        deliveredAt: new Date(now - 55000),
      },
    });
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'SECURITY', channel: 'email',
        body: 'Login alert', sentAt: new Date(now - 120000),
        deliveredAt: new Date(now - 90000),
      },
    });
    await ctx.prisma.notification.create({
      data: {
        userId: ctx.user.id, type: 'MARKETING', channel: 'push',
        body: 'New feature', sentAt: new Date(now - 30000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/delivery-latency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(3);
    expect(body.deliveredCount).toBe(2);
    expect(body.avgLatencyMs).toBeGreaterThan(0);
    expect(body.byChannel.length).toBe(2);
    expect(body.slaCompliance).toBeGreaterThanOrEqual(0);
  });
});
