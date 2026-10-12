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
    payload: { email: 'b31@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b31@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('dispute resolution report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns report after resolved disputes', async () => {
    const gp = await ctx.prisma.gatewayPayment.create({
      data: { userId: ctx.user.id, gateway: 'stripe', externalId: 'ext-rr-1', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED' },
    });
    const dispute = await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayPaymentId: gp.id, reason: 'fraud', amount: 50, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${dispute.json().id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'WON' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/resolution-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolvedCount).toBe(1);
    expect(res.json().byOutcome.WON).toBe(1);
    expect(typeof res.json().evidenceSubmissionRate).toBe('number');
  });

  it('returns empty report with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/resolution-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalDisputes).toBe(0);
    expect(res.json().resolvedCount).toBe(0);
  });
});

describe('subscription churn analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns analysis after cancellations', async () => {
    const sub = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 29.99, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${sub.json().id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/churn-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelledCount).toBe(1);
    expect(res.json().churnRate).toBeGreaterThan(0);
    expect(res.json().mostCancelledPlans.length).toBe(1);
  });

  it('returns zero churn with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/churn-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelledCount).toBe(0);
    expect(res.json().churnRate).toBe(0);
  });
});

describe('transaction velocity report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns velocity after transactions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 1000 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/withdraw',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transactions/velocity-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTransactions).toBeGreaterThanOrEqual(2);
    expect(res.json().dailyAverage).toBeGreaterThan(0);
    expect(res.json().peakDay).toBeDefined();
    expect(res.json().largestTransaction).toBeDefined();
  });

  it('returns empty report with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transactions/velocity-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTransactions).toBe(0);
  });
});

describe('savings goal completion forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns forecast with active goals', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation', targetAmount: 5000, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/completion-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalActiveGoals).toBe(1);
    expect(res.json().forecasts).toHaveLength(1);
    expect(res.json().forecasts[0].name).toBe('Vacation');
  });

  it('returns empty forecast with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/completion-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalActiveGoals).toBe(0);
    expect(res.json().forecasts).toHaveLength(0);
  });
});

describe('loan risk assessment', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns assessment after loan approval', async () => {
    const loanRes = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5000, currency: 'USD', termMonths: 12 },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanRes.json().id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeLoans).toBe(1);
    expect(typeof res.json().debtToPrincipalRatio).toBe('number');
    expect(typeof res.json().onTimePercent).toBe('number');
    expect(typeof res.json().totalPrincipal).toBe('string');
  });

  it('returns empty assessment with no loans', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeLoans).toBe(0);
  });
});
