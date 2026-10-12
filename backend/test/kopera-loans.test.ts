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
    payload: { email: 'loan@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'loan@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera loans', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('simulates a loan without persisting', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loans/simulate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10000, currency: 'PEN', termMonths: 12 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.monthlyPayment).toBeGreaterThan(0);
    expect(body.totalInterest).toBeGreaterThan(0);
    expect(body.tcea).toBeGreaterThan(0);
    expect(body.schedule).toBeDefined();
    expect(body.schedule.length).toBe(12);
  });

  it('applies for a loan', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5000, currency: 'USD', termMonths: 24 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('APPLICATION');
    expect(body.currency).toBe('USD');
    expect(body.termMonths).toBe(24);
  });

  it('lists user loans', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5000, currency: 'PEN', termMonths: 12 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10000, currency: 'USD', termMonths: 36 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets loan by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 3000, currency: 'EUR', termMonths: 6 },
    });
    const loanId = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loanId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(loanId);
  });

  it('returns 404 for non-existent loan', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loans/simulate',
      payload: { amount: 1000, currency: 'PEN', termMonths: 12 },
    });
    expect(res.statusCode).toBe(401);
  });
});
