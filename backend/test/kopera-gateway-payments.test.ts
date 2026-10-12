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
    payload: { email: 'gw-payments@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'gw-payments@kopera.io', code: reg.json().debugOtp },
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

describe('kopera gateway payment creation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a CARD payment with correct fee', async () => {
    const res = await createPayment(ctx);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('CAPTURED');
    expect(body.paymentMethod).toBe('CARD');
    expect(body.amount).toBe('5000');
    expect(body.currency).toBe('USD');
    expect(body.antifraudDecision).toBe('APPROVE');
    // CARD fee: ceil(5000 * 0.029) + 30 = 145 + 30 = 175
    expect(body.gatewayFee).toBe('175');
    expect(body.webhookDelivered).toBe(false);
  });

  it('creates a BANK_TRANSFER payment with lower fee', async () => {
    const res = await createPayment(ctx, { paymentMethod: 'BANK_TRANSFER' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.paymentMethod).toBe('BANK_TRANSFER');
    // BANK_TRANSFER fee: ceil(5000 * 0.005) + 0 = 25
    expect(body.gatewayFee).toBe('25');
  });

  it('creates a PIX payment with fee', async () => {
    const res = await createPayment(ctx, { paymentMethod: 'PIX', currency: 'BRL' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.paymentMethod).toBe('PIX');
    // PIX fee: ceil(5000 * 0.008) = 40
    expect(body.gatewayFee).toBe('40');
  });

  it('creates a STABLECOIN payment with lowest fee', async () => {
    const res = await createPayment(ctx, { paymentMethod: 'STABLECOIN', currency: 'USD' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // STABLECOIN fee: ceil(5000 * 0.003) = 15
    expect(body.gatewayFee).toBe('15');
  });

  it('returns idempotent result for duplicate key', async () => {
    const res1 = await createPayment(ctx, { idempotencyKey: 'test-idem-1' });
    expect(res1.statusCode).toBe(201);

    const res2 = await createPayment(ctx, { idempotencyKey: 'test-idem-1' });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().id).toBe(res1.json().id);
  });

  it('sets threeDSecureStatus to required for large CARD payments', async () => {
    const res = await createPayment(ctx, { amount: 200 });
    expect(res.statusCode).toBe(201);
    // 200 * 100 = 20000 > 10000 threshold
    expect(res.json().threeDSecureStatus).toBe('required');
  });

  it('sets threeDSecureStatus to not_required for small CARD payments', async () => {
    const res = await createPayment(ctx, { amount: 50 });
    expect(res.statusCode).toBe(201);
    expect(res.json().threeDSecureStatus).toBe('not_required');
  });

  it('lists user payments endpoint returns 200', async () => {
    await createPayment(ctx, { amount: 10 });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payments',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('gets payment by id', async () => {
    const create = await createPayment(ctx);
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/gateway/payments/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('returns 404 for unknown payment', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payments/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth for payment creation', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments',
      payload: { amount: 10, currency: 'USD', paymentMethod: 'CARD' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('kopera gateway webhook delivery', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('marks webhook as delivered', async () => {
    const create = await createPayment(ctx);
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${id}/webhook-delivered`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhookDelivered).toBe(true);
  });

  it('rejects duplicate webhook delivery', async () => {
    const create = await createPayment(ctx);
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${id}/webhook-delivered`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${id}/webhook-delivered`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_delivered');
  });

  it('returns 404 for unknown payment webhook', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments/nonexistent/webhook-delivered',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('kopera gateway payment links (persisted)', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a persisted payment link via gateway', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 75, currency: 'USD', description: 'Gateway link' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.code).toBeTruthy();
    expect(body.url).toContain(body.code);
    expect(body.amount).toBe('7500');
    expect(body.currency).toBe('USD');
    expect(body.description).toBe('Gateway link');
    expect(body.status).toBe('active');
    expect(body.expiresAt).toBeTruthy();
  });

  it('persists the link in the database', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 30, currency: 'PEN' },
    });
    const code = create.json().code;

    // Verify it's retrievable through the payment-links API
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/payment-links/code/${code}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe('3000');
    expect(res.json().currency).toBe('PEN');
  });

  it('requires auth for gateway payment links', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payment-links',
      payload: { amount: 10, currency: 'USD' },
    });
    expect(res.statusCode).toBe(401);
  });
});
