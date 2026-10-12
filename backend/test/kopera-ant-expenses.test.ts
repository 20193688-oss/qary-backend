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

const EXPENSE_PAYLOAD = {
  category: 'coffee', merchantName: 'Starbucks', amount: 5,
  currency: 'USD', frequency: 'daily', monthlyTotal: 150,
  yearlyProjection: 1800, suggestion: 'Brew at home',
  savingsIfCut: 1500,
};

describe('kopera ant expenses', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('detects an ant expense', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EXPENSE_PAYLOAD,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category).toBe('coffee');
    expect(res.json().merchantName).toBe('Starbucks');
    expect(res.json().amount).toBe('500');
    expect(res.json().monthlyTotal).toBe('15000');
    expect(res.json().isActive).toBe(true);
  });

  it('lists active expenses', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EXPENSE_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...EXPENSE_PAYLOAD, category: 'streaming', merchantName: 'Netflix', amount: 15, monthlyTotal: 15, yearlyProjection: 180 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('returns spending summary', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EXPENSE_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/summary/USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('USD');
    expect(res.json().count).toBe(1);
    expect(res.json().totalMonthly).toBe('15000');
  });

  it('dismisses an expense', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EXPENSE_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/ant-expenses/${create.json().id}/dismiss`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('prevents double dismiss', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EXPENSE_PAYLOAD,
    });
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/ant-expenses/${id}/dismiss`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/ant-expenses/${id}/dismiss`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_dismissed');
  });

  it('prevents duplicate tracking', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EXPENSE_PAYLOAD,
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: EXPENSE_PAYLOAD,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('expense_already_tracked');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/ant-expenses' });
    expect(res.statusCode).toBe(401);
  });
});
