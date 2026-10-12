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
    payload: { email: 'b39@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b39@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('account health report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns health report for new account', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/health-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.overallScore).toBe('number');
    expect(body.healthGrade).toBeDefined();
    expect(typeof body.profileCompleteness).toBe('number');
    expect(typeof body.securityPercent).toBe('number');
    expect(body.securityChecks).toBeDefined();
    expect(typeof body.securityChecks.mfaEnabled).toBe('boolean');
    expect(typeof body.securityChecks.pinSet).toBe('boolean');
    expect(typeof body.accountAgeDays).toBe('number');
    expect(body.walletCount).toBe(0);
    expect(body.totalBalance).toBe('0');
    expect(body.recommendations).toBeInstanceOf(Array);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });

  it('improves health after profile completion and wallet creation', async () => {
    await ctx.app.inject({
      method: 'PATCH', url: '/api/profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Test User', phone: '+51999999999', locale: 'es', timezone: 'America/Lima', country: 'PE', preferredCurrency: 'PEN' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/profile/pin',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { pin: '123456' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 1000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile/health-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profileCompleteness).toBe(100);
    expect(body.securityChecks.pinSet).toBe(true);
    expect(body.walletCount).toBe(1);
    expect(Number(body.totalBalance)).toBeGreaterThan(0);
    expect(body.recentActivityCount).toBeGreaterThan(0);
    expect(body.overallScore).toBeGreaterThan(0);
  });
});
