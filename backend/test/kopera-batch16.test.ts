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
    payload: { email: 'b16@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b16@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

async function createSecondUser(ctx: Awaited<ReturnType<typeof bootstrap>>) {
  const reg = await ctx.app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'b16-other@kopera.io' },
  });
  const v = await ctx.app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b16-other@kopera.io', code: reg.json().debugOtp },
  });
  return v.json();
}

describe('FX admin store rates', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('stores a new FX rate', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/rates',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { baseCurrency: 'USD', quoteCurrency: 'PEN', bid: 3.70, ask: 3.80, source: 'market_feed' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.baseCurrency).toBe('USD');
    expect(body.quoteCurrency).toBe('PEN');
    expect(body.bid).toBe(3.70);
    expect(body.ask).toBe(3.80);
    expect(body.source).toBe('market_feed');
  });

  it('rejects bid >= ask', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fx/rates',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { baseCurrency: 'USD', quoteCurrency: 'PEN', bid: 3.80, ask: 3.70, source: 'test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bid_must_be_less_than_ask');
  });
});

describe('points manual earn', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('awards points to a user', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 500, reason: 'promotional credit' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().earned).toBe(500);
    expect(res.json().balance).toBe(500);
  });

  it('accumulates points across multiple earn calls', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 200, reason: 'bonus' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 300, reason: 'referral' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().balance).toBe(500);
  });
});

describe('loan repayment mark-overdue', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createLoanWithRepayments() {
    const loan = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD', termMonths: 3 },
    });
    const loanId = loan.json().id;
    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const reps = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loanId}/repayments`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    return { loanId, repayments: reps.json() };
  }

  it('marks a repayment as overdue', async () => {
    const { repayments } = await createLoanWithRepayments();
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/repayments/${repayments[0].id}/mark-overdue`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('OVERDUE');
  });

  it('rejects marking paid repayment as overdue', async () => {
    const { repayments } = await createLoanWithRepayments();
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50000, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/repayments/${repayments[0].id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: Number(repayments[0].amount) / 100 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/repayments/${repayments[0].id}/mark-overdue`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_paid');
  });
});

describe('savings goal update', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createGoal() {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation', targetAmount: 500, currency: 'USD' },
    });
    return res.json();
  }

  it('updates goal name and target', async () => {
    const goal = await createGoal();
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/savings-goals/${goal.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Beach Trip', targetAmount: 1000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Beach Trip');
    expect(res.json().targetAmount).toBe('100000');
  });

  it('rejects updating archived goal', async () => {
    const goal = await createGoal();
    await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${goal.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/savings-goals/${goal.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'New Name' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('goal_archived');
  });
});

describe('scheduled transfer update', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  let other: { accessToken: string; user: { id: string } };
  beforeEach(async () => {
    ctx = await bootstrap();
    other = await createSecondUser(ctx);
  });

  async function createTransfer() {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: other.user.id, currency: 'USD', amount: 50, frequency: 'weekly' },
    });
    return res.json();
  }

  it('updates amount and description', async () => {
    const st = await createTransfer();
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/scheduled-transfers/${st.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, description: 'Updated weekly payment' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe('10000');
    expect(res.json().description).toBe('Updated weekly payment');
  });

  it('rejects editing cancelled transfer', async () => {
    const st = await createTransfer();
    await ctx.app.inject({
      method: 'POST', url: `/api/scheduled-transfers/${st.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/scheduled-transfers/${st.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 200 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('transfer_not_editable');
  });
});

describe('loan reject', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('rejects a loan application', async () => {
    const loan = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5000, currency: 'USD', termMonths: 12 },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loan.json().id}/reject`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Insufficient credit history' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
  });

  it('rejects rejecting an already approved loan', async () => {
    const loan = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5000, currency: 'USD', termMonths: 12 },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loan.json().id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loan.json().id}/reject`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Changed mind' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('loan_not_pending');
  });

  it('returns 404 for nonexistent loan', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loans/nonexistent/reject',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'test' },
    });
    expect(res.statusCode).toBe(404);
  });
});
