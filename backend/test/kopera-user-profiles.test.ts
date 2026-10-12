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
    payload: { email: 'profile@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'profile@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera user profiles', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('gets user profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('profile@kopera.io');
    expect(res.json().id).toBe(ctx.user.id);
  });

  it('updates profile fields', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Juan Perez', locale: 'en-US', preferredCurrency: 'USD' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Juan Perez');
    expect(res.json().locale).toBe('en-US');
    expect(res.json().preferredCurrency).toBe('USD');
  });

  it('enables MFA', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/mfa/enable',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secret: 'JBSWY3DPEHPK3PXP' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mfaEnabled).toBe(true);
  });

  it('prevents double MFA enable', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/profile/mfa/enable',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secret: 'JBSWY3DPEHPK3PXP' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/mfa/enable',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secret: 'OTHER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mfa_already_enabled');
  });

  it('disables MFA', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/profile/mfa/enable',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secret: 'JBSWY3DPEHPK3PXP' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/mfa/disable',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mfaEnabled).toBe(false);
  });

  it('sets PIN', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/pin',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { pin: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('upgrades to business account', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/upgrade-business',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accountType).toBe('BUSINESS');
  });

  it('prevents double business upgrade', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/profile/upgrade-business',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/upgrade-business',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_business');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/profile' });
    expect(res.statusCode).toBe(401);
  });
});
