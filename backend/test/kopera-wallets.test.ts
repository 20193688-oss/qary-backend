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
    payload: { email: 'wallet@kopera.io', password: 'WalletTest1!' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'wallet@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  // second user for transfers
  const reg2 = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'receiver@kopera.io' },
  });
  const v2 = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'receiver@kopera.io', code: reg2.json().debugOtp },
  });
  const receiver = v2.json().user;

  return { app, prisma, accessToken, user, receiver };
}

describe('kopera wallets', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a wallet', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().currency).toBe('PEN');
    expect(res.json().balance).toBe('0');
  });

  it('returns empty wallets list initially', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('deposits and reflects balance', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reference).toMatch(/^DEP-/);
    expect(Number(body.balance)).toBeGreaterThan(0);
  });

  it('withdraws from wallet', async () => {
    // deposit first
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/withdraw',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 200 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reference).toMatch(/^WDR-/);
  });

  it('rejects withdraw with insufficient funds', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'EUR', amount: 10 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/withdraw',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'EUR', amount: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_funds');
  });

  it('transfers between users', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/transfer',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.receiver.id, currency: 'USD', amount: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reference).toMatch(/^TRF-/);
    expect(res.json().transactionId).toBeTruthy();
  });

  it('gets wallet balance by currency', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 1000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/PEN',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('PEN');
    expect(Number(res.json().balance)).toBeGreaterThan(0);
  });

  it('returns 404 for non-existent wallet currency', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/JPY',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists transactions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 50 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transactions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('requires auth on all endpoints', async () => {
    const endpoints = [
      { method: 'GET' as const, url: '/api/wallets' },
      { method: 'POST' as const, url: '/api/wallets', payload: { currency: 'PEN' } },
      { method: 'POST' as const, url: '/api/wallets/deposit', payload: { currency: 'PEN', amount: 10 } },
      { method: 'GET' as const, url: '/api/transactions' },
    ];
    for (const ep of endpoints) {
      const res = await ctx.app.inject(ep);
      expect(res.statusCode).toBe(401);
    }
  });
});
