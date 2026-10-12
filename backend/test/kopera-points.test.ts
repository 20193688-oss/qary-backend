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
    payload: { email: 'points@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'points@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera points', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('gets initial points balance (auto-creates)', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.balance).toBe(0);
    expect(body.tier).toBe('BRONZE');
    expect(body.nextTier).toBe('SILVER');
    expect(body.pointsToNextTier).toBe(1000);
  });

  it('gets points history (empty initially)', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('rejects redeem with insufficient points', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/points/redeem',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, reason: 'Discount' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_points');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points',
    });
    expect(res.statusCode).toBe(401);
  });
});
