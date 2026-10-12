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
    payload: { email: 'linkowner@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'linkowner@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera payment links', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payment link', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD', description: 'Dinner split' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.amount).toBe('5000');
    expect(body.currency).toBe('USD');
    expect(body.description).toBe('Dinner split');
    expect(body.status).toBe('active');
    expect(body.code).toBeTruthy();
    expect(body.singleUse).toBe(true);
  });

  it('lists payment links', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 20, currency: 'PEN' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets payment link by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 25, currency: 'EUR' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/payment-links/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('resolves payment link by code (public)', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD', description: 'Invoice payment' },
    });
    const code = create.json().code;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/payment-links/code/${code}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe('10000');
    expect(res.json().status).toBe('active');
  });

  it('deactivates a payment link', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 30, currency: 'USD' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-links/${id}/deactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('deactivated');
  });

  it('prevents double deactivation', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 30, currency: 'USD' },
    });
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/payment-links/${id}/deactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-links/${id}/deactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_deactivated');
  });

  it('returns 404 for unknown code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/code/DOESNOTEXIST',
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth for creating links', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      payload: { amount: 10, currency: 'USD' },
    });
    expect(res.statusCode).toBe(401);
  });
});
