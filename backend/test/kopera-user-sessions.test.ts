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
    payload: { email: 'session@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'session@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera user sessions', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  const SESSION_PAYLOAD = {
    deviceId: 'device-abc-123',
    deviceName: 'iPhone 15',
    ip: '192.168.1.1',
    userAgent: 'Mozilla/5.0',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };

  it('creates a session', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: SESSION_PAYLOAD,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().deviceId).toBe('device-abc-123');
    expect(res.json().deviceName).toBe('iPhone 15');
    expect(res.json().revokedAt).toBeNull();
  });

  it('lists active sessions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: SESSION_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...SESSION_PAYLOAD, deviceId: 'device-xyz-456', deviceName: 'Pixel 8' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets session by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: SESSION_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/sessions/${create.json().id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(create.json().id);
  });

  it('revokes a session', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: SESSION_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/sessions/${create.json().id}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revokedAt).toBeTruthy();
  });

  it('prevents double revoke', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: SESSION_PAYLOAD,
    });
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/sessions/${id}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/sessions/${id}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_revoked');
  });

  it('revokes all other sessions', async () => {
    const s1 = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: SESSION_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...SESSION_PAYLOAD, deviceId: 'device-2' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...SESSION_PAYLOAD, deviceId: 'device-3' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/sessions/revoke-others',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currentSessionId: s1.json().id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(2);

    const list = await ctx.app.inject({
      method: 'GET', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(list.json().length).toBe(1);
    expect(list.json()[0].id).toBe(s1.json().id);
  });

  it('returns 404 for unknown session', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
  });
});
