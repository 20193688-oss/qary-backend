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
    payload: { email: 'wallet-admin@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'wallet-admin@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  await app.inject({
    method: 'POST', url: '/api/wallets/deposit',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { currency: 'PEN', amount: 500 },
  });

  return { app, prisma, accessToken, user };
}

describe('kopera wallet admin operations', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('freezes a wallet', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/freeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FROZEN');
  });

  it('prevents withdrawals on frozen wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/freeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/withdraw',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('wallet_frozen');
  });

  it('unfreezes a wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/freeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/unfreeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('rejects unfreezing a non-frozen wallet', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/unfreeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_frozen');
  });

  it('rejects double freeze', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/freeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/freeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_frozen');
  });

  it('holds and releases funds', async () => {
    const holdRes = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/hold',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100 },
    });
    expect(holdRes.statusCode).toBe(200);
    expect(holdRes.json().holdBalance).toBe('10000');
    expect(holdRes.json().availableBalance).toBe('40000');

    const releaseRes = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/release',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50 },
    });
    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().holdBalance).toBe('5000');
    expect(releaseRes.json().availableBalance).toBe('45000');
  });

  it('rejects hold exceeding available balance', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/hold',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 600 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_available');
  });

  it('rejects release exceeding hold', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/PEN/release',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('hold_exceeds_balance');
  });

  it('sets default wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/USD/set-default',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isDefault).toBe(true);

    const walletsRes = await ctx.app.inject({
      method: 'GET', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const walletsList = walletsRes.json();
    const penWallet = walletsList.find((w: any) => w.currency === 'PEN');
    const usdWallet = walletsList.find((w: any) => w.currency === 'USD');
    expect(penWallet.isDefault).toBe(false);
    expect(usdWallet.isDefault).toBe(true);
  });

  it('returns 404 for non-existent wallet', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/EUR/freeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('wallet_not_found');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/wallets/PEN/freeze' });
    expect(res.statusCode).toBe(401);
  });
});
