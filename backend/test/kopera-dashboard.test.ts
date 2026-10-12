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
    payload: { email: 'dashboard@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'dashboard@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera dashboard endpoint', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns dashboard with empty data', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/dashboard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallets).toEqual([]);
    expect(body.totalBalance).toEqual({});
    expect(body.recentTransactions).toEqual([]);
    expect(body.unreadNotifications).toBe(0);
    expect(body.activeGoals).toEqual([]);
    expect(body.activeSubscriptions).toEqual([]);
    expect(body.pendingPayments).toBe(0);
    expect(body.transactionLimits).toEqual([]);
  });

  it('includes wallet data in dashboard', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/dashboard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallets.length).toBe(1);
    expect(body.wallets[0].currency).toBe('USD');
    expect(body.wallets[0].status).toBe('ACTIVE');
  });

  it('includes recent transactions in dashboard', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 25, currency: 'USD', paymentMethod: 'CARD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/dashboard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recentTransactions.length).toBeGreaterThanOrEqual(1);
    expect(body.recentTransactions[0].type).toBe('PAYMENT');
  });

  it('includes transaction limits in dashboard', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 5000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/dashboard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactionLimits.length).toBe(1);
    expect(body.transactionLimits[0].currency).toBe('USD');
    expect(body.transactionLimits[0].limitType).toBe('daily');
  });

  it('requires auth for dashboard', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/dashboard',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('kopera payment receipt', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('generates receipt for captured payment', async () => {
    const payment = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD', paymentMethod: 'CARD' },
    });
    const paymentId = payment.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/gateway/payments/${paymentId}/receipt`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receiptId).toMatch(/^RCP-/);
    expect(body.paymentId).toBe(paymentId);
    expect(body.amount).toBe('10000');
    expect(body.currency).toBe('USD');
    expect(body.gatewayFee).toBeTruthy();
    expect(body.netAmount).toBeTruthy();
    expect(body.paidBy).toBeTruthy();
    expect(body.paidBy.email).toBe('dashboard@kopera.io');
    expect(body.issuedAt).toBeTruthy();
  });

  it('returns 404 for non-existent payment receipt', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payments/nonexistent/receipt',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth for receipt', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payments/some-id/receipt',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('kopera notification cleanup', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('deletes read notifications', async () => {
    const prisma = ctx.prisma as any;
    await prisma.notification.create({
      data: {
        userId: ctx.user.id,
        type: 'info',
        title: 'Read notification',
        message: 'This was read',
        readAt: new Date(),
      },
    });
    await prisma.notification.create({
      data: {
        userId: ctx.user.id,
        type: 'info',
        title: 'Unread notification',
        message: 'This is unread',
      },
    });

    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/notifications/read',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(1);
  });

  it('returns zero when no read notifications', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/notifications/read',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(0);
  });

  it('requires auth for notification cleanup', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/notifications/read',
    });
    expect(res.statusCode).toBe(401);
  });
});
