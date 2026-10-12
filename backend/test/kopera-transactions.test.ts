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
    payload: { email: 'txuser@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'txuser@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  await app.inject({
    method: 'POST', url: '/api/wallets',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { currency: 'USD' },
  });
  await app.inject({
    method: 'POST', url: '/api/wallets/deposit',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { currency: 'USD', amount: 500 },
  });

  return { app, prisma, accessToken, user };
}

describe('kopera transactions', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    expect(res.json()[0].type).toBe('DEPOSIT');
  });

  it('filters by type', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history?type=DEPOSIT',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().every((t: any) => t.type === 'DEPOSIT')).toBe(true);
  });

  it('gets transaction by id', async () => {
    const list = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const id = list.json()[0].id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/transaction-history/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    expect(res.json().amount).toBeTruthy();
  });

  it('gets transaction by reference', async () => {
    const list = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const ref = list.json()[0].reference;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/transaction-history/reference/${encodeURIComponent(ref)}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reference).toBe(ref);
  });

  it('returns summary', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/summary/USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('USD');
    expect(res.json().totalIn).toBe('50000');
    expect(res.json().count).toBe(1);
  });

  it('returns 404 for unknown transaction', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/transaction-history' });
    expect(res.statusCode).toBe(401);
  });
});
