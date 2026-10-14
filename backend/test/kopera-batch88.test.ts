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
    payload: { email: 'b88@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b88@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('wallet dormancy report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns no_data with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/dormancy-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(0);
    expect(body.dormancyLevel).toBe('no_data');
  });

  it('analyzes dormancy with mixed wallet states', async () => {
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(10000), status: 'active' },
    });
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'EUR', balance: BigInt(0), status: 'frozen' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/dormancy-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(2);
    expect(body.breakdown.dormant).toBeGreaterThanOrEqual(1);
    expect(body.dormancyLevel).toBeDefined();
    expect(body.dormancyScore).toBeGreaterThan(0);
  });
});
