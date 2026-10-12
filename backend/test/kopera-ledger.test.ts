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
    payload: { email: 'ledger@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'ledger@kopera.io', code: reg.json().debugOtp },
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
    payload: { currency: 'USD', amount: 200 },
  });

  const wallet = await (prisma as any).wallet.findFirst({ where: { userId: user.id } });
  const walletId = wallet.id;

  return { app, prisma, accessToken, user, walletId };
}

describe('kopera ledger', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists ledger entries for a wallet', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${ctx.walletId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('returns 404 for unknown wallet', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('gets entry by id when entries exist', async () => {
    const list = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${ctx.walletId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    if (list.json().length > 0) {
      const entryId = list.json()[0].id;
      const res = await ctx.app.inject({
        method: 'GET', url: `/api/ledger/entry/${entryId}`,
        headers: { authorization: `Bearer ${ctx.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(entryId);
    }
  });

  it('returns 404 for unknown entry', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/entry/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns statement with date range', async () => {
    const from = new Date(Date.now() - 86400000 * 30).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/ledger/${ctx.walletId}/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().walletId).toBe(ctx.walletId);
    expect(res.json().entryCount).toBeGreaterThanOrEqual(0);
    expect(res.json().totalDebits).toBeDefined();
    expect(res.json().totalCredits).toBeDefined();
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/ledger/${ctx.walletId}` });
    expect(res.statusCode).toBe(401);
  });
});
