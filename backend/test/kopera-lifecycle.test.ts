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
    payload: { email: 'lifecycle@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'lifecycle@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('dispute resolution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createDispute() {
    const payment = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD', paymentMethod: 'CARD' },
    });
    const paymentId = payment.json().id;

    const dispute = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${paymentId}/dispute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Unauthorized charge' },
    });
    return dispute.json();
  }

  it('resolves dispute as WON', async () => {
    const dispute = await createDispute();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${dispute.id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'WON', notes: 'Customer was right' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('WON');
    expect(res.json().outcome).toBe('Customer was right');
    expect(res.json().resolvedAt).toBeTruthy();
  });

  it('resolves dispute as LOST', async () => {
    const dispute = await createDispute();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${dispute.id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'LOST' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('LOST');
  });

  it('resolves dispute as ACCEPTED', async () => {
    const dispute = await createDispute();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${dispute.id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'ACCEPTED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACCEPTED');
  });

  it('prevents double resolution', async () => {
    const dispute = await createDispute();

    await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${dispute.id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'WON' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${dispute.id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'LOST' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('dispute_already_resolved');
  });

  it('returns 404 for non-existent dispute', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/disputes/nonexistent/resolve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'WON' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('invoice lifecycle', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createInvoice(overrides?: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        type: 'FACTURA',
        currency: 'PEN',
        subtotal: 100,
        country: 'PE',
        senderName: 'Test Corp',
        ...overrides,
      },
    });
    return res.json();
  }

  it('marks invoice as paid', async () => {
    const invoice = await createInvoice();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAID');
  });

  it('prevents paying already paid invoice', async () => {
    const invoice = await createInvoice();

    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_paid');
  });

  it('voids an invoice', async () => {
    const invoice = await createInvoice();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/void`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('VOIDED');
  });

  it('cancels an invoice', async () => {
    const invoice = await createInvoice();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('prevents cancelling a paid invoice', async () => {
    const invoice = await createInvoice();

    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_status');
  });

  it('lists received invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/received',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('checks overdue invoices', async () => {
    const prisma = ctx.prisma as any;
    await prisma.invoice.create({
      data: {
        senderId: ctx.user.id,
        type: 'FACTURA',
        status: 'ISSUED',
        currency: 'PEN',
        subtotal: BigInt(10000),
        taxAmount: BigInt(1800),
        totalAmount: BigInt(11800),
        country: 'PE',
        dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoices/check-overdue',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(1);
  });

  it('returns 404 for void on non-existent invoice', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoices/nonexistent/void',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('subscription billing', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createSub(overrides?: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        planName: 'Pro',
        amount: 29.99,
        currency: 'USD',
        interval: 'monthly',
        ...overrides,
      },
    });
    return res.json();
  }

  it('updates subscription plan', async () => {
    const sub = await createSub();

    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/subscriptions/${sub.id}/plan`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Enterprise', amount: 99.99 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().planName).toBe('Enterprise');
    expect(res.json().amount).toBe('9999');
  });

  it('prevents plan update on cancelled subscription', async () => {
    const sub = await createSub();

    await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${sub.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/subscriptions/${sub.id}/plan`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'New', amount: 50 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_cancelled');
  });

  it('resume recalculates billing dates', async () => {
    const sub = await createSub();

    await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${sub.id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${sub.id}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    const nextBilling = new Date(body.nextBillingDate);
    expect(nextBilling.getTime()).toBeGreaterThan(Date.now());
  });

  it('processes due billings with sufficient wallet balance', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });

    const prisma = ctx.prisma as any;
    await prisma.subscription.create({
      data: {
        userId: ctx.user.id,
        planName: 'Test',
        amount: BigInt(2999),
        currency: 'USD',
        interval: 'monthly',
        intervalCount: 1,
        status: 'active',
        currentPeriodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() - 1000),
        nextBillingDate: new Date(Date.now() - 1000),
        retryCount: 0,
        maxRetries: 3,
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions/process-billing',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBeGreaterThanOrEqual(1);
    expect(body.results.some((r: any) => r.success)).toBe(true);
  });

  it('marks subscription past_due after max retries with insufficient funds', async () => {
    const prisma = ctx.prisma as any;
    await prisma.subscription.create({
      data: {
        userId: ctx.user.id,
        planName: 'Expensive',
        amount: BigInt(999999),
        currency: 'USD',
        interval: 'monthly',
        intervalCount: 1,
        status: 'active',
        currentPeriodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() - 1000),
        nextBillingDate: new Date(Date.now() - 1000),
        retryCount: 2,
        maxRetries: 3,
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions/process-billing',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.some((r: any) => r.reason === 'max_retries_exceeded')).toBe(true);
  });

  it('process-billing returns empty when nothing is due', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions/process-billing',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(0);
  });
});
