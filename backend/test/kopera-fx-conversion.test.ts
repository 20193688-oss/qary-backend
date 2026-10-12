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
  const { accessToken, user } = v.json();

  await app.inject({
    method: 'POST', url: '/api/wallets/deposit',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { currency: 'USD', amount: 1000 },
  });

  return { app, prisma, accessToken, user };
}

describe('kopera fx conversion execution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('executes a currency conversion', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'PEN' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.transactionId).toBeTruthy();
    expect(body.reference).toMatch(/^FX-/);
    expect(body.fromCurrency).toBe('USD');
    expect(body.toCurrency).toBe('PEN');
    expect(body.fromAmount).toBe('10000');
    expect(Number(body.toAmount)).toBeGreaterThan(0);
    expect(body.rate).toBeGreaterThan(0);
  });

  it('debits source wallet and credits target wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'PEN' },
    });

    const usdRes = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(Number(usdRes.json().balance)).toBe(90000);

    const penRes = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/PEN',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(Number(penRes.json().balance)).toBeGreaterThan(0);
  });

  it('rejects insufficient funds', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 2000, fromCurrency: 'USD', toCurrency: 'PEN' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_funds');
  });

  it('rejects missing source wallet', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, fromCurrency: 'EUR', toCurrency: 'PEN' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('source_wallet_not_found');
  });

  it('creates ledger entries for both wallets', async () => {
    const execRes = await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, fromCurrency: 'USD', toCurrency: 'PEN' },
    });
    expect(execRes.statusCode).toBe(201);

    const usdWallet = (ctx.prisma as any).__tables.wallet.find(
      (w: any) => w.userId === ctx.user.id && w.currency === 'USD',
    );
    const penWallet = (ctx.prisma as any).__tables.wallet.find(
      (w: any) => w.userId === ctx.user.id && w.currency === 'PEN',
    );

    const ledger = (ctx.prisma as any).__tables.ledgerEntry;
    const usdEntries = ledger.filter((e: any) => e.walletId === usdWallet.id);
    const penEntries = ledger.filter((e: any) => e.walletId === penWallet.id);

    expect(usdEntries.length).toBeGreaterThanOrEqual(2);
    expect(penEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects frozen source wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/USD/freeze',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, fromCurrency: 'USD', toCurrency: 'PEN' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('source_wallet_frozen');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'PEN' },
    });
    expect(res.statusCode).toBe(401);
  });
});
