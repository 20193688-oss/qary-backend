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
    payload: { email: 'fx@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'fx@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken } = v.json();

  return { app, accessToken };
}

describe('kopera fx', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('gets exchange rate for USD/PEN (public)', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/rate/USD-PEN',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bid).toBeGreaterThan(0);
    expect(body.ask).toBeGreaterThan(0);
    expect(body.mid).toBeGreaterThan(0);
  });

  it('accepts various pair separators', async () => {
    for (const sep of ['-', '_']) {
      const res = await ctx.app.inject({
        method: 'GET', url: `/api/fx/rate/USD${sep}EUR`,
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('returns 400 for invalid pair format', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/rate/INVALID',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_pair_format');
  });

  it('returns supported pairs list', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/pairs',
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('converts currency (requires auth)', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/convert',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'PEN' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rate).toBeGreaterThan(0);
    expect(Number(body.toAmount)).toBeGreaterThan(0);
  });

  it('convert rejects without auth', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/convert',
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'PEN' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('gets a fx quote with buy and sell rates', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/quote',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, fromCurrency: 'USD', toCurrency: 'EUR' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.buyRate).toBeGreaterThan(0);
    expect(body.sellRate).toBeGreaterThan(0);
    expect(body.validForSeconds).toBe(30);
  });
});
