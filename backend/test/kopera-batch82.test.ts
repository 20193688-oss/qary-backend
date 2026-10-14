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
    payload: { email: 'b82@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b82@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('wallet health dashboard', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns defaults with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/health-dashboard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(0);
    expect(body.healthLevel).toBe('no_data');
  });

  it('analyzes health with wallets', async () => {
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000), isDefault: true },
    });
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'EUR', balance: BigInt(30000) },
    });
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'GBP', balance: BigInt(0) },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/health-dashboard',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(3);
    expect(body.healthScore).toBeGreaterThan(0);
    expect(body.currencyBreakdown.length).toBe(3);
    expect(body.summary.zeroBalance).toBe(1);
    expect(body.healthLevel).toBeDefined();
  });
});
