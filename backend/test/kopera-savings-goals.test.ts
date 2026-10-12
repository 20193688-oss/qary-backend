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
    payload: { email: 'saver@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'saver@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera savings goals', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a savings goal', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation Fund', targetAmount: 5000, currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Vacation Fund');
    expect(body.targetAmount).toBe('500000');
    expect(body.currentAmount).toBe('0');
    expect(body.status).toBe('active');
    expect(body.progress).toBe(0);
  });

  it('lists savings goals', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Goal A', targetAmount: 1000, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Goal B', targetAmount: 2000, currency: 'PEN' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets savings goal by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Emergency', targetAmount: 10000, currency: 'USD' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/savings-goals/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('contributes to a goal and tracks progress', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Car', targetAmount: 100, currency: 'USD' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${id}/contribute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentAmount).toBe('5000');
    expect(res.json().progress).toBe(50);
    expect(res.json().status).toBe('active');
  });

  it('completes a goal when target is reached', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Phone', targetAmount: 100, currency: 'USD' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${id}/contribute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
    expect(res.json().progress).toBe(100);
    expect(res.json().completedAt).toBeTruthy();
  });

  it('withdraws from a goal', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Trip', targetAmount: 500, currency: 'PEN' },
    });
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${id}/contribute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 200 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${id}/withdraw`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentAmount).toBe('15000');
  });

  it('rejects withdrawal exceeding savings', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Laptop', targetAmount: 2000, currency: 'USD' },
    });
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${id}/contribute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${id}/withdraw`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 200 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_savings');
  });

  it('archives a goal', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Old Goal', targetAmount: 1000, currency: 'EUR' },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('archived');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals',
    });
    expect(res.statusCode).toBe(401);
  });
});
