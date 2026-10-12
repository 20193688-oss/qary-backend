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
    payload: { email: 'sub@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'sub@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera subscriptions', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a subscription', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        planName: 'Premium Monthly',
        amount: 29.99,
        currency: 'USD',
        interval: 'monthly',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.planName).toBe('Premium Monthly');
    expect(body.status).toBe('active');
    expect(body.amount).toBe('2999');
    expect(body.interval).toBe('monthly');
    expect(body.nextBillingDate).toBeTruthy();
  });

  it('lists user subscriptions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Plan A', amount: 10, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Plan B', amount: 20, currency: 'PEN', interval: 'yearly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets subscription by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Basic', amount: 5, currency: 'EUR', interval: 'weekly' },
    });
    const subId = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/subscriptions/${subId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(subId);
  });

  it('cancels a subscription', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 49.99, currency: 'USD', interval: 'monthly' },
    });
    const subId = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${subId}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(res.json().cancelledAt).toBeTruthy();
  });

  it('prevents double cancel', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 49.99, currency: 'USD', interval: 'monthly' },
    });
    const subId = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${subId}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${subId}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_cancelled');
  });

  it('pauses and resumes a subscription', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Standard', amount: 15, currency: 'USD', interval: 'monthly' },
    });
    const subId = create.json().id;

    const pause = await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${subId}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().status).toBe('paused');

    const resume = await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${subId}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().status).toBe('active');
  });

  it('returns 404 for non-existent subscription', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions',
    });
    expect(res.statusCode).toBe(401);
  });
});
