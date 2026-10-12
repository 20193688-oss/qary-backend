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
    payload: { email: 'sched-sender@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'sched-sender@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  const reg2 = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'sched-receiver@kopera.io' },
  });
  const v2 = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'sched-receiver@kopera.io', code: reg2.json().debugOtp },
  });
  const receiver = v2.json().user;

  return { app, prisma, accessToken, user, receiver };
}

describe('kopera scheduled transfers', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a scheduled transfer', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        toUserId: ctx.receiver.id,
        currency: 'USD',
        amount: 50,
        frequency: 'monthly',
        description: 'Rent payment',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.toUserId).toBe(ctx.receiver.id);
    expect(body.amount).toBe('5000');
    expect(body.frequency).toBe('monthly');
    expect(body.status).toBe('active');
    expect(body.nextExecutionDate).toBeTruthy();
  });

  it('lists scheduled transfers', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.receiver.id, currency: 'USD', amount: 25, frequency: 'weekly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.receiver.id, currency: 'PEN', amount: 100, frequency: 'once' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets scheduled transfer by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.receiver.id, currency: 'EUR', amount: 75, frequency: 'daily' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/scheduled-transfers/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('cancels a scheduled transfer', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.receiver.id, currency: 'USD', amount: 30, frequency: 'monthly' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/scheduled-transfers/${id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
  });

  it('prevents double cancel', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.receiver.id, currency: 'USD', amount: 30, frequency: 'monthly' },
    });
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/scheduled-transfers/${id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/scheduled-transfers/${id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_cancelled');
  });

  it('pauses and resumes a transfer', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.receiver.id, currency: 'USD', amount: 10, frequency: 'weekly' },
    });
    const id = create.json().id;

    const pause = await ctx.app.inject({
      method: 'POST', url: `/api/scheduled-transfers/${id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().status).toBe('paused');

    const resume = await ctx.app.inject({
      method: 'POST', url: `/api/scheduled-transfers/${id}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().status).toBe('active');
  });

  it('rejects transfer to self', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.user.id, currency: 'USD', amount: 10, frequency: 'once' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_transfer_to_self');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers',
    });
    expect(res.statusCode).toBe(401);
  });
});
