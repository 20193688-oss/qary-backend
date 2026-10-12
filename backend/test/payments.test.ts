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
    payload: { email: 'pay@b.com', password: 'longpass1' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'pay@b.com', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, stripe, accessToken, user };
}

describe('payments + webhooks + receipts', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a PaymentIntent (manual capture)', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payments/intent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amountCents: 1500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clientSecret).toMatch(/_secret_/);
    expect(ctx.stripe.__intents.size).toBe(1);
  });

  it('webhook with bad signature is rejected', async () => {
    ctx.stripe.__setSignatureValid(false);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'stripe-signature': 'bad' },
      payload: { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_signature');
  });

  it('webhook payment_intent.succeeded updates gateway payment + idempotent', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST', url: '/api/payments/intent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amountCents: 1500 },
    });
    expect(createRes.statusCode).toBe(200);
    const intentId = [...ctx.stripe.__intents.keys()][0];

    const eventBody = {
      id: 'evt_succ_1', type: 'payment_intent.succeeded',
      data: { object: { id: intentId } },
    };
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'stripe-signature': 'whatever' },
      payload: eventBody,
    });
    expect(r1.statusCode).toBe(200);

    // idempotent
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'stripe-signature': 'whatever' },
      payload: eventBody,
    });
    expect(r2.json().idempotent).toBe(true);
  });

  it('receipt is 409 until captured, then JSON + HMAC valid', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/payments/intent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amountCents: 1500 },
    });
    const tbls = (ctx.prisma as unknown as { __tables: { gatewayPayment: Array<{ id: string; processorRef: string; status: string }> } }).__tables;
    const gp = tbls.gatewayPayment[0]!;

    // before capture
    const before = await ctx.app.inject({ method: 'GET', url: `/api/receipts/${gp.id}` });
    expect(before.statusCode).toBe(409);

    // simulate webhook succeeded
    await ctx.app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'stripe-signature': 'sig' },
      payload: { id: 'evt_cap', type: 'payment_intent.succeeded', data: { object: { id: gp.processorRef } } },
    });

    const json = await ctx.app.inject({ method: 'GET', url: `/api/receipts/${gp.id}` });
    expect(json.statusCode).toBe(200);
    expect(json.json().signature).toMatch(/^[a-f0-9]{64}$/);

    const html = await ctx.app.inject({
      method: 'GET', url: `/api/receipts/${gp.id}`,
      headers: { accept: 'text/html' },
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('KOPERA · Recibo');
  });
});
