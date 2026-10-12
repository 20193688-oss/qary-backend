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
    payload: { email: 'b15@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b15@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

async function createSecondUser(ctx: Awaited<ReturnType<typeof bootstrap>>) {
  const reg = await ctx.app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'b15-other@kopera.io' },
  });
  const v = await ctx.app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b15-other@kopera.io', code: reg.json().debugOtp },
  });
  return v.json();
}

describe('transaction date filtering and total count', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns total count with transactions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by date range', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });

    const future = new Date(Date.now() + 86400000 * 365).toISOString();
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/transaction-history?from=${future}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
  });
});

describe('transaction CSV export', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('exports transactions as CSV', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/export',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const csv = res.body;
    expect(csv).toContain('id,type,status,amount,currency');
    expect(csv.split('\n').length).toBeGreaterThan(1);
  });

  it('exports empty CSV when no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/export',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id,type,status');
    expect(res.body.trim().split('\n').length).toBe(1);
  });
});

describe('per-wallet transaction history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists transactions for a specific wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/USD/transactions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(1);
    expect(res.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for nonexistent wallet', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/EUR/transactions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('payment link pay-via-link', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  let other: { accessToken: string; user: { id: string } };
  beforeEach(async () => {
    ctx = await bootstrap();
    other = await createSecondUser(ctx);
  });

  it('pays through a payment link', async () => {
    const link = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 25, currency: 'USD' },
    });
    const code = link.json().code;

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-links/pay/${code}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().paid).toBe(true);
    expect(res.json().transactionId).toBeTruthy();
  });

  it('rejects paying own link', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });

    const link = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-links/pay/${link.json().code}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_pay_own_link');
  });

  it('rejects paying with insufficient funds', async () => {
    const link = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-links/pay/${link.json().code}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_funds');
  });

  it('returns 404 for nonexistent link code', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links/pay/BADCODE',
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('KYB approve and reject', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function registerBusiness() {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyb/register',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        taxId: '20123456789',
        taxIdType: 'RUC',
        taxIdCountry: 'PE',
        tradeName: 'Test Corp',
      },
    });
  }

  it('approves a KYB application', async () => {
    await registerBusiness();

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyb/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
    expect(res.json().verifiedAt).toBeTruthy();
  });

  it('prevents double approval', async () => {
    await registerBusiness();

    await ctx.app.inject({
      method: 'POST', url: '/api/kyb/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyb/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_approved');
  });

  it('rejects a KYB application', async () => {
    await registerBusiness();

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyb/reject',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, reason: 'Incomplete documents' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
    expect(res.json().rejectedReason).toBe('Incomplete documents');
  });

  it('returns 404 for missing KYB', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyb/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: 'nonexistent' },
    });
    expect(res.statusCode).toBe(404);
  });
});
