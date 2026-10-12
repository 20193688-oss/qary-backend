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
    payload: { email: 'repay@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'repay@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  const loanRes = await app.inject({
    method: 'POST', url: '/api/loans/apply',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { amount: 1000, currency: 'USD', termMonths: 3 },
  });
  const loanId = loanRes.json().id;

  await app.inject({
    method: 'POST', url: `/api/loans/${loanId}/approve`,
    headers: { authorization: `Bearer ${accessToken}` },
  });

  return { app, prisma, accessToken, user, loanId };
}

describe('kopera loan repayments', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists repayments for a loan', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${ctx.loanId}/repayments`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(3);
    expect(res.json()[0].installment).toBe(1);
    expect(res.json()[0].status).toBe('PENDING');
  });

  it('gets repayment schedule summary', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${ctx.loanId}/repayments/summary`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalInstallments).toBe(3);
    expect(res.json().paidCount).toBe(0);
    expect(res.json().pendingCount).toBe(3);
  });

  it('gets repayment by id', async () => {
    const list = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${ctx.loanId}/repayments`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const repaymentId = list.json()[0].id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/repayments/${repaymentId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(repaymentId);
    expect(res.json().installment).toBe(1);
  });

  it('makes a payment', async () => {
    const list = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${ctx.loanId}/repayments`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const repayment = list.json()[0];
    const amountDue = Number(repayment.amount) / 100;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/repayments/${repayment.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: amountDue },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAID');
    expect(res.json().paidAt).toBeTruthy();
  });

  it('prevents double payment', async () => {
    const list = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${ctx.loanId}/repayments`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const repayment = list.json()[0];
    const amountDue = Number(repayment.amount) / 100;

    await ctx.app.inject({
      method: 'POST', url: `/api/repayments/${repayment.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: amountDue },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/repayments/${repayment.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: amountDue },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_paid');
  });

  it('supports partial payment', async () => {
    const list = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${ctx.loanId}/repayments`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const repayment = list.json()[0];

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/repayments/${repayment.id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PARTIAL');
  });

  it('returns 404 for unknown loan', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/nonexistent/repayments',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${ctx.loanId}/repayments`,
    });
    expect(res.statusCode).toBe(401);
  });
});
