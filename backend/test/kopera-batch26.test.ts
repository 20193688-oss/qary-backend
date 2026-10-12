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
    payload: { email: 'b26@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b26@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('loan overdue repayments', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns overdue repayments after disbursing a loan', async () => {
    const applyRes = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD', termMonths: 3 },
    });
    const loanId = applyRes.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/disburse`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    // Backdate a repayment to make it overdue
    const repayments = await ctx.prisma.loanRepayment.findMany({});
    const first = repayments.find((r: any) => r.loanId === loanId && r.installment === 1);
    if (first) {
      await ctx.prisma.loanRepayment.update({
        where: { id: first.id },
        data: { dueDate: new Date('2020-01-01') },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/overdue-repayments',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    expect(res.json()[0].daysOverdue).toBeGreaterThan(0);
  });

  it('returns empty when no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/overdue-repayments',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('dispute expiring evidence', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns disputes with approaching evidence deadlines', async () => {
    // Create a gateway payment directly in prisma
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD' },
    });
    const txn = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'DEPOSIT', status: 'COMPLETED',
        amount: BigInt(10000), currency: 'USD', description: 'test',
        reference: 'REF-1', receiverWalletId: wallet.id,
      },
    });
    const gp = await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn.id, provider: 'stripe', externalId: 'ext1',
        paymentMethod: 'card', amount: BigInt(10000), currency: 'USD',
        status: 'CAPTURED',
      },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayPaymentId: gp.id, reason: 'fraud', amount: 100, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/expiring-evidence?days=60',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    expect(res.json()[0].daysRemaining).toBeGreaterThan(0);
  });

  it('returns empty when no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/expiring-evidence',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('invoice aging report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns aging buckets with invoices', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'FACTURA', currency: 'USD', subtotal: 500, country: 'US' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/aging',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Number(res.json().totalOutstanding)).toBeGreaterThan(0);
    expect(res.json().buckets.current.count).toBe(1);
  });

  it('returns zeros when no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/aging',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalOutstanding).toBe('0');
    expect(res.json().buckets.current.count).toBe(0);
  });
});

describe('profile security activity', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns security-related events after profile actions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/profile/pin',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { pin: '123456' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/security-activity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    const types = res.json().map((e: any) => e.eventType);
    expect(types).toContain('profile.pin_set');
  });

  it('returns events with valid structure', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/security-activity',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('wallet portfolio', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns portfolio after creating wallets', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'EUR' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/portfolio',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalWallets).toBe(2);
    expect(res.json().currencies).toContain('USD');
    expect(res.json().currencies).toContain('EUR');
    expect(res.json().byStatus.ACTIVE).toBe(2);
  });

  it('returns empty portfolio when no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/portfolio',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalWallets).toBe(0);
    expect(res.json().totalHold).toBe('0');
  });
});
