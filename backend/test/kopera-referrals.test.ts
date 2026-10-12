import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryPrisma, createInMemoryRedis, createMockStripe } from './_mocks.js';

async function bootstrap() {
  const prisma = createInMemoryPrisma();
  const redis = createInMemoryRedis();
  const stripe = createMockStripe();
  const app = await buildApp({ prisma, redis, stripe: stripe as never });
  await app.ready();

  const reg1 = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'referrer@kopera.io' },
  });
  const v1 = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'referrer@kopera.io', code: reg1.json().debugOtp },
  });
  const referrer = v1.json();

  const reg2 = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'referred@kopera.io' },
  });
  const v2 = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'referred@kopera.io', code: reg2.json().debugOtp },
  });
  const referred = v2.json();

  return { app, prisma, referrer, referred };
}

describe('kopera referrals', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('generates a referral code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBeTruthy();
    expect(res.json().code.length).toBe(8);
  });

  it('returns same code on subsequent calls', async () => {
    const res1 = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    const res2 = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    expect(res1.json().code).toBe(res2.json().code);
  });

  it('applies a referral code', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    const code = codeRes.json().code;

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(true);
    expect(res.json().referrerId).toBe(ctx.referrer.user.id);
  });

  it('shows referral stats', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    const code = codeRes.json().code;

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
      payload: { code },
    });

    const stats = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/stats',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().signupCount).toBe(1);
  });

  it('rewards the referrer', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    const code = codeRes.json().code;

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
      payload: { code },
    });

    const reward = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/reward',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
    });
    expect(reward.statusCode).toBe(200);
    expect(reward.json().rewarded).toBe(true);
    expect(reward.json().pointsAwarded).toBe(500);

    const stats = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/stats',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    expect(stats.json().rewardedCount).toBe(1);
    expect(stats.json().totalPointsEarned).toBe(500);
  });

  it('lists signups', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    const code = codeRes.json().code;

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
      payload: { code },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/signups',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].referredUserId).toBe(ctx.referred.user.id);
  });

  it('rejects invalid referral code', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
      payload: { code: 'INVALID' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('invalid_referral_code');
  });

  it('prevents self-referral', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    const code = codeRes.json().code;

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
      payload: { code },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_refer_self');
  });

  it('prevents double referral', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.referrer.accessToken}` },
    });
    const code = codeRes.json().code;

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
      payload: { code },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${ctx.referred.accessToken}` },
      payload: { code },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_referred');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
    });
    expect(res.statusCode).toBe(401);
  });
});
