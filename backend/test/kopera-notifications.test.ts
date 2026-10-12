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
    payload: { email: 'notif@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'notif@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera notifications', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty list initially', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns unread count of 0 initially', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/unread-count',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
  });

  it('lists notifications after creation', async () => {
    await (ctx.prisma as any).notification.create({
      data: {
        userId: ctx.user.id,
        type: 'IN_APP',
        channel: 'in_app',
        body: 'Welcome to Kopera!',
        subject: 'Welcome',
        sentAt: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.length).toBe(1);
    expect(list[0].body).toBe('Welcome to Kopera!');
    expect(list[0].readAt).toBeNull();
  });

  it('marks a notification as read', async () => {
    const n = await (ctx.prisma as any).notification.create({
      data: {
        userId: ctx.user.id,
        type: 'IN_APP',
        channel: 'in_app',
        body: 'You received a payment',
        sentAt: new Date(),
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/notifications/${n.id}/read`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().readAt).toBeTruthy();
  });

  it('marks all as read', async () => {
    await (ctx.prisma as any).notification.create({
      data: { userId: ctx.user.id, type: 'IN_APP', channel: 'in_app', body: 'msg1', sentAt: new Date() },
    });
    await (ctx.prisma as any).notification.create({
      data: { userId: ctx.user.id, type: 'IN_APP', channel: 'in_app', body: 'msg2', sentAt: new Date() },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/read-all',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);
  });

  it('returns 404 for non-existent notification', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/nonexistent/read',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications',
    });
    expect(res.statusCode).toBe(401);
  });
});
