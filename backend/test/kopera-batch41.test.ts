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
    payload: { email: 'b41@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b41@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ledger anomaly detection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns low risk for empty wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    const summary = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const walletId = summary.json()[0].walletId;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${walletId}/anomaly-detection`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.walletId).toBe(walletId);
    expect(body.entryCount).toBe(0);
    expect(body.anomalies).toBeInstanceOf(Array);
    expect(body.riskScore).toBe(0);
    expect(body.riskLevel).toBe('low');
  });

  it('detects anomalies after deposits', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 100 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN', amount: 100 },
    });

    const summary = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const walletId = summary.json()[0].walletId;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${walletId}/anomaly-detection`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entryCount).toBe(2);
    expect(body.anomalies).toBeInstanceOf(Array);
    expect(typeof body.riskScore).toBe('number');
    expect(['low', 'medium', 'high']).toContain(body.riskLevel);
  });
});

describe('events compliance report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns compliance report', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/compliance-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.totalEvents).toBe('number');
    expect(typeof body.sensitiveEventCount).toBe('number');
    expect(body.byCategory).toBeDefined();
    expect(body.retentionBuckets).toBeDefined();
    expect(typeof body.dataRetentionDays).toBe('number');
    expect(body.recommendations).toBeInstanceOf(Array);
  });

  it('counts events after creating audit entries', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'user', eventType: 'auth.login', payload: {} },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'user', eventType: 'transfer.sent', payload: {} },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/compliance-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThanOrEqual(2);
    expect(body.sensitiveEventCount).toBeGreaterThanOrEqual(1);
    expect(body.byCategory['auth']).toBeGreaterThanOrEqual(1);
  });
});

describe('transaction cash flow forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty forecast with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/cash-flow-forecast?currency=USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe('USD');
    expect(body.forecastDays).toBe(30);
    expect(body.historicalDays).toBe(0);
    expect(body.avgDailyInflow).toBe('0');
    expect(body.avgDailyOutflow).toBe('0');
    expect(body.confidence).toBe('none');
  });

  it('forecasts after deposits', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/cash-flow-forecast?currency=USD&days=60',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe('USD');
    expect(body.forecastDays).toBe(60);
    expect(Number(body.avgDailyInflow)).toBeGreaterThanOrEqual(0);
    expect(body.byType).toBeDefined();
  });
});

describe('loan repayment amortization analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns amortization analysis for a loan', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });

    const loanRes = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD', termMonths: 6, purpose: 'test' },
    });
    const loanId = loanRes.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { interestRate: 10 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loanId}/repayments/amortization`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.loanId).toBe(loanId);
    expect(body.totalInstallments).toBe(6);
    expect(Number(body.totalPrincipal)).toBeGreaterThan(0);
    expect(Number(body.totalInterest)).toBeGreaterThanOrEqual(0);
    expect(Number(body.totalCost)).toBeGreaterThan(0);
    expect(typeof body.interestToTotalRatio).toBe('number');
    expect(body.progressPercent).toBe(0);
    expect(body.schedule).toBeInstanceOf(Array);
    expect(body.schedule.length).toBe(6);
    expect(body.schedule[0].installment).toBe(1);
  });
});

describe('business profile due diligence', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 when no profile exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/due-diligence',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns due diligence report for a new profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxId: '20123456789', taxIdType: 'RUC', taxIdCountry: 'PE' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/due-diligence',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(ctx.user.id);
    expect(typeof body.profileCompleteness).toBe('number');
    expect(typeof body.overallScore).toBe('number');
    expect(body.overallStatus).toBeDefined();
    expect(body.checks).toBeInstanceOf(Array);
    expect(body.checks.length).toBe(5);
    expect(body.blockers).toBeInstanceOf(Array);
    expect(body.blockers.length).toBeGreaterThan(0);
    expect(body.checks.find((c: any) => c.area === 'identity').status).toBe('pass');
  });
});
