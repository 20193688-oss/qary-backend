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
    payload: { email: 'earner@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'earner@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera auto-earn points on wallet transactions', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('earns points on deposit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBeGreaterThan(0);
    expect(res.json().lifetimeEarned).toBeGreaterThan(0);
  });

  it('earns points on transfer', async () => {
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'receiver2@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'receiver2@kopera.io', code: reg2.json().debugOtp },
    });
    const receiverId = v2.json().user.id;

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });

    const before = await ctx.app.inject({
      method: 'GET', url: '/api/points',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const balanceBefore = before.json().balance;

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/transfer',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: receiverId, currency: 'USD', amount: 200 },
    });

    const after = await ctx.app.inject({
      method: 'GET', url: '/api/points',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(after.json().balance).toBeGreaterThan(balanceBefore);
  });

  it('points history shows earning events', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 1000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const history = res.json();
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((h: any) => h.type === 'EARN')).toBe(true);
  });
});
