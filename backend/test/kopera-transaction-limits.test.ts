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
    payload: { email: 'limiter@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'limiter@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera transaction limits', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('sets a daily limit', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 1000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxAmount).toBe('100000');
    expect(body.currentUsage).toBe('0');
    expect(body.limitType).toBe('daily');
  });

  it('sets a monthly limit', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', limitType: 'monthly', maxAmount: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().limitType).toBe('monthly');
    expect(res.json().maxAmount).toBe('500000');
  });

  it('lists all limits', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 500 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'monthly', maxAmount: 10000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets a specific limit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/USD/daily',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().remaining).toBe('50000');
  });

  it('checks and increments usage', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 100 },
    });

    const check = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits/check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 50 },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().allowed).toBe(true);

    const after = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/USD/daily',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(after.json().currentUsage).toBe('5000');
  });

  it('rejects transaction exceeding limit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', limitType: 'daily', maxAmount: 100 },
    });

    const check = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits/check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 200 },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().allowed).toBe(false);
    expect(check.json().reason).toBe('daily_limit_exceeded');
  });

  it('removes a limit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/transaction-limits',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'EUR', limitType: 'daily', maxAmount: 200 },
    });

    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/transaction-limits/EUR/daily',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const check = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits/EUR/daily',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(check.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-limits',
    });
    expect(res.statusCode).toBe(401);
  });
});
