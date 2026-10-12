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
    payload: { email: 'b30@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b30@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('wallet activity summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns activity after deposits and withdrawals', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/withdraw',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/activity-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().walletCount).toBeGreaterThanOrEqual(1);
    const walletEntries = Object.values(res.json().byWallet) as any[];
    const usdWallet = walletEntries.find((w: any) => w.currency === 'USD');
    expect(usdWallet).toBeDefined();
    expect(usdWallet.deposits).toBeGreaterThanOrEqual(1);
  });

  it('returns empty summary with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/activity-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().walletCount).toBe(0);
  });
});

describe('session security overview', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns overview after creating sessions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-1', deviceName: 'iPhone', ip: '1.2.3.4', expiresAt: new Date(Date.now() + 86400000).toISOString() },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-2', deviceName: 'Chrome', ip: '5.6.7.8', expiresAt: new Date(Date.now() + 86400000).toISOString() },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/security-overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSessions).toBeGreaterThanOrEqual(2);
    expect(res.json().uniqueDevices).toBeGreaterThanOrEqual(2);
    expect(res.json().uniqueIps).toBeGreaterThanOrEqual(2);
  });

  it('returns empty overview with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/security-overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSessions).toBe(0);
  });
});

describe('ledger flow analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns flow analysis after transactions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 1000 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/withdraw',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 200 },
    });

    const wallets = await ctx.app.inject({
      method: 'GET', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const usdWallet = wallets.json().find((w: any) => w.currency === 'USD');
    const walletObj = await ctx.prisma.wallet.findFirst({ where: { userId: ctx.user.id, currency: 'USD' } });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ledger/${walletObj!.id}/flow-analysis`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entryCount).toBeGreaterThanOrEqual(2);
    expect(Number(res.json().totalCredits)).toBeGreaterThan(0);
    expect(Number(res.json().peakBalance)).toBeGreaterThan(0);
  });

  it('returns 404 for unknown wallet', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/nonexistent-id/flow-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('events activity timeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns timeline with events', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'user', eventType: 'login', payload: {} },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'user', eventType: 'page_view', payload: {} },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/timeline?days=7',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEvents).toBeGreaterThanOrEqual(2);
    expect(res.json().topEventTypes.length).toBeGreaterThanOrEqual(1);
    expect(res.json().days).toBe(7);
  });

  it('returns timeline scoped to recent days only', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/timeline?days=1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toBe(1);
  });
});

describe('loan repayment payment history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns payment history for a loan', async () => {
    const loanRes = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD', termMonths: 3 },
    });
    const loanId = loanRes.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loanId}/repayments/payment-history`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().loanId).toBe(loanId);
    expect(res.json().totalInstallments).toBe(3);
    expect(res.json().payments).toHaveLength(3);
    expect(typeof res.json().totalOwed).toBe('string');
  });

  it('returns 404 for unknown loan', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/nonexistent/repayments/payment-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
