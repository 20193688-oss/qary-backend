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
    payload: { email: 'b35@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b35@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('ledger reconciliation report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns clean report after deposit', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 200 },
    });

    const summary = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const walletId = summary.json()[0].walletId;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${walletId}/reconciliation`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('clean');
    expect(body.balanceMatchesLedger).toBe(true);
    expect(body.totalEntries).toBeGreaterThanOrEqual(1);
    expect(typeof body.walletBalance).toBe('string');
    expect(typeof body.computedBalance).toBe('string');
    expect(body.mismatches).toHaveLength(0);
  });

  it('returns 404 for non-existent wallet', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/nonexistent/reconciliation',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('events security audit', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns audit with events', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'user', eventType: 'auth.login', payload: {} },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'user', eventType: 'auth.failed', payload: {}, severity: 'WARNING' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/security-audit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSecurityEvents).toBeGreaterThanOrEqual(2);
    expect(body.byType['auth.login']).toBeGreaterThanOrEqual(1);
    expect(body.byType['auth.failed']).toBeGreaterThanOrEqual(1);
    expect(typeof body.riskLevel).toBe('string');
    expect(body.recentActivity).toBeInstanceOf(Array);
  });

  it('returns low risk with no events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/security-audit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSecurityEvents).toBe(0);
    expect(body.riskLevel).toBe('low');
  });
});

describe('transaction counterparty report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns report after transactions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/counterparty-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBeGreaterThanOrEqual(1);
    expect(body.topCounterparties).toBeInstanceOf(Array);
    if (body.topCounterparties.length > 0) {
      expect(typeof body.topCounterparties[0].totalSent).toBe('string');
      expect(typeof body.topCounterparties[0].totalReceived).toBe('string');
    }
  });

  it('returns empty report with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/counterparty-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.totalCounterparties).toBe(0);
  });
});

describe('loan repayment delinquency report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  let loanId: string;
  beforeEach(async () => {
    ctx = await bootstrap();
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 10000 },
    });
    const loan = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD', termMonths: 6, purpose: 'test' },
    });
    loanId = loan.json().id;
    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/disburse`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
  });

  it('returns delinquency for active loan', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loanId}/repayments/delinquency`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.loanId).toBe(loanId);
    expect(body.totalInstallments).toBe(6);
    expect(typeof body.delinquencyRate).toBe('number');
    expect(typeof body.severity).toBe('string');
    expect(typeof body.overdueAmount).toBe('string');
  });

  it('returns 404 for non-existent loan', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/nonexistent/repayments/delinquency',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('business profile compliance readiness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns readiness after creating profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        taxId: 'RUC123456', taxIdType: 'RUC', taxIdCountry: 'PE',
        legalName: 'Test Corp', legalRepName: 'John Doe', legalRepDocNumber: 'DOC123',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/compliance-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isReady).toBe(false);
    expect(typeof body.readinessPercent).toBe('number');
    expect(body.blockers).toBeInstanceOf(Array);
    expect(body.checks).toBeInstanceOf(Array);
    expect(body.passedChecks).toBeGreaterThanOrEqual(3);
  });

  it('returns 404 without profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/compliance-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
