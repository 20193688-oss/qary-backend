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
    payload: { email: 'gw-enhanced@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'gw-enhanced@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

async function createPayment(ctx: Awaited<ReturnType<typeof bootstrap>>, overrides?: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/gateway/payments',
    headers: { authorization: `Bearer ${ctx.accessToken}` },
    payload: {
      amount: 50,
      currency: 'USD',
      paymentMethod: 'CARD',
      ...overrides,
    },
  });
  return res;
}

describe('kopera gateway transaction limit integration', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('allows payment when under daily limit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 1000 },
    });

    const res = await createPayment(ctx, { amount: 50 });
    expect(res.statusCode).toBe(201);
  });

  it('blocks payment when daily limit exceeded', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 30 },
    });

    const res = await createPayment(ctx, { amount: 50 });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('transaction_limit_exceeded');
    expect(res.json().reason).toBe('daily_limit_exceeded');
  });

  it('blocks second payment that would exceed limit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 80 },
    });

    const first = await createPayment(ctx, { amount: 50 });
    expect(first.statusCode).toBe(201);

    const second = await createPayment(ctx, { amount: 50 });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe('transaction_limit_exceeded');
  });

  it('allows payment with no limits set', async () => {
    const res = await createPayment(ctx, { amount: 10000 });
    expect(res.statusCode).toBe(201);
  });
});

describe('kopera gateway dispute creation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a dispute for a payment', async () => {
    const payment = await createPayment(ctx);
    const paymentId = payment.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${paymentId}/dispute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Unauthorized charge' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.gatewayPaymentId).toBe(paymentId);
    expect(body.reason).toBe('Unauthorized charge');
    expect(body.amount).toBe('5000');
    expect(body.currency).toBe('USD');
    expect(body.status).toBe('OPENED');
    expect(body.evidenceDeadline).toBeTruthy();
  });

  it('creates dispute with custom amount', async () => {
    const payment = await createPayment(ctx, { amount: 100 });
    const paymentId = payment.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${paymentId}/dispute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Partial dispute', amount: 30 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe('3000');
  });

  it('sets payment status to DISPUTED', async () => {
    const payment = await createPayment(ctx);
    const paymentId = payment.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${paymentId}/dispute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Fraud' },
    });

    const check = await ctx.app.inject({
      method: 'GET', url: `/api/gateway/payments/${paymentId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(check.json().status).toBe('DISPUTED');
  });

  it('prevents duplicate dispute', async () => {
    const payment = await createPayment(ctx);
    const paymentId = payment.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${paymentId}/dispute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'First dispute' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${paymentId}/dispute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Second dispute' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('dispute_already_exists');
  });

  it('returns 404 for non-existent payment', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments/nonexistent/dispute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Test' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth for dispute', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments/some-id/dispute',
      payload: { reason: 'Test' },
    });
    expect(res.statusCode).toBe(401);
  });
});
