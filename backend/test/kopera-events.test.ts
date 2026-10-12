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
    payload: { email: 'audit@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'audit@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera events', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  const EVENT_PAYLOAD = {
    actor: 'user',
    eventType: 'login',
    payload: { method: 'otp' },
    ip: '10.0.0.1',
  };

  it('logs an event', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EVENT_PAYLOAD,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().eventType).toBe('login');
    expect(res.json().actor).toBe('user');
    expect(res.json().userId).toBe(ctx.user.id);
  });

  it('lists events', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EVENT_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...EVENT_PAYLOAD, eventType: 'transfer' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(2);
  });

  it('filters by eventType', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EVENT_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...EVENT_PAYLOAD, eventType: 'transfer' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events?eventType=login',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].eventType).toBe('login');
  });

  it('gets event by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EVENT_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/events/${create.json().id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(create.json().id);
  });

  it('logs with severity', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...EVENT_PAYLOAD, severity: 'WARNING', eventType: 'suspicious_login' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().severity).toBe('WARNING');
  });

  it('groups by requestId', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...EVENT_PAYLOAD, requestId: 'req-abc' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...EVENT_PAYLOAD, eventType: 'transfer', requestId: 'req-abc' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/request/req-abc',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('returns 404 for unknown event', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/events' });
    expect(res.statusCode).toBe(401);
  });
});
