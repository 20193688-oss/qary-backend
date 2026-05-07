import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryPrisma, createInMemoryRedis, createMockStripe } from './_mocks.js';

async function makeApp() {
  const prisma = createInMemoryPrisma();
  const redis = createInMemoryRedis();
  const stripe = createMockStripe() as never;
  const app = await buildApp({ prisma, redis, stripe });
  await app.ready();
  return { app, prisma, redis };
}

describe('auth flow', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app'];

  beforeEach(async () => { ({ app } = await makeApp()); });

  it('register → debug OTP returned in non-prod', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'a@b.com', name: 'A', password: 'longpass1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBeTruthy();
    expect(body.debugOtp).toMatch(/^\d{4}$/);
  });

  it('verify-otp issues access + refresh', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'b@b.com' },
    });
    const { debugOtp } = reg.json();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'b@b.com', code: debugOtp },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.email).toBe('b@b.com');
  });

  it('verify-otp rejects wrong code', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'c@b.com' } });
    const res = await app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'c@b.com', code: '0000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('login with password works after register', async () => {
    await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'd@b.com', password: 'longpass1' },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'd@b.com', password: 'longpass1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
  });

  it('refresh rotates token; old token cannot be reused', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'e@b.com' } });
    const v = await app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'e@b.com', code: reg.json().debugOtp },
    });
    const { refreshToken } = v.json();
    const r1 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    expect(r2.statusCode).toBe(401);
    expect(r2.json().error).toBe('revoked');
  });

  it('logout revokes the refresh token', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'f@b.com' } });
    const v = await app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'f@b.com', code: reg.json().debugOtp },
    });
    const { refreshToken } = v.json();
    await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refreshToken } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    expect(r.statusCode).toBe(401);
  });

  it('me requires Bearer; pin can be set', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'g@b.com' } });
    const v = await app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'g@b.com', code: reg.json().debugOtp },
    });
    const { accessToken } = v.json();
    const me = await app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('g@b.com');
    const setPin = await app.inject({
      method: 'POST', url: '/api/auth/pin',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { pin: '1234' },
    });
    expect(setPin.statusCode).toBe(200);
  });
});
