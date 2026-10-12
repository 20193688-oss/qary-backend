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
    payload: { email: 'cardholder@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'cardholder@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera tokenized cards', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('adds a card', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        vaultToken: 'tok_abc123', last4: '4242', network: 'VISA',
        expiryMonth: 12, expiryYear: 2027, holderName: 'Test User',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().last4).toBe('4242');
    expect(res.json().network).toBe('VISA');
    expect(res.json().isDefault).toBe(true);
  });

  it('lists cards', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_1', last4: '1111', network: 'VISA', expiryMonth: 6, expiryYear: 2026 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_2', last4: '2222', network: 'MASTERCARD', expiryMonth: 9, expiryYear: 2027 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets card by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_x', last4: '9999', network: 'AMEX', expiryMonth: 3, expiryYear: 2028 },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/cards/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('sets default card', async () => {
    const c1 = await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_a', last4: '1111', network: 'VISA', expiryMonth: 1, expiryYear: 2026 },
    });
    const c2 = await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_b', last4: '2222', network: 'VISA', expiryMonth: 2, expiryYear: 2026 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cards/${c2.json().id}/default`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isDefault).toBe(true);
  });

  it('removes a card', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_del', last4: '5555', network: 'VISA', expiryMonth: 5, expiryYear: 2026 },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/cards/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const check = await ctx.app.inject({
      method: 'GET', url: `/api/cards/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(check.statusCode).toBe(404);
  });

  it('prevents duplicate fingerprint', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_fp1', last4: '3333', network: 'VISA', expiryMonth: 1, expiryYear: 2026, fingerprint: 'fp_unique' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_fp2', last4: '3333', network: 'VISA', expiryMonth: 1, expiryYear: 2026, fingerprint: 'fp_unique' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('card_already_exists');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/cards' });
    expect(res.statusCode).toBe(401);
  });
});
