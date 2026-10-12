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
    payload: { email: 'b21@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b21@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('FX rate history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns stored rate history for a pair', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/fx/rates',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { baseCurrency: 'USD', quoteCurrency: 'PEN', bid: 3.70, ask: 3.75, source: 'test1' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/fx/rates',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { baseCurrency: 'USD', quoteCurrency: 'PEN', bid: 3.71, ask: 3.76, source: 'test2' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/rate/USD-PEN/history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
    expect(res.json()[0].baseCurrency).toBe('USD');
    expect(res.json()[0].quoteCurrency).toBe('PEN');
  });

  it('returns empty array when no history exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/rate/EUR-JPY/history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('loan summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns aggregate loan summary', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10000, currency: 'USD', termMonths: 12 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 5000, currency: 'USD', termMonths: 6 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLoans).toBe(2);
    expect(Number(res.json().totalPrincipal)).toBeGreaterThan(0);
    expect(res.json().byStatus.APPLICATION).toBe(2);
  });

  it('returns zeros when no loans exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLoans).toBe(0);
    expect(res.json().totalPrincipal).toBe('0');
  });
});

describe('business profile screening and verification status', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createProfile(ctx: Awaited<ReturnType<typeof bootstrap>>) {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxId: '20123456789', taxIdType: 'RUC', taxIdCountry: 'PE', legalName: 'TestCo' },
    });
  }

  it('runs screening and updates scores', async () => {
    await createProfile(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/business-profile/screening',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { riskScore: 25, complianceScore: 90 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().riskScore).toBe(25);
  });

  it('returns 404 when no profile for screening', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/business-profile/screening',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { riskScore: 50 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns verification status', async () => {
    await createProfile(ctx);
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/verification-status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PENDING');
    expect(res.json().verifiedAt).toBeNull();
  });

  it('returns 404 for verification status without profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/verification-status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('ledger balance summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns multi-wallet balance summary', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'PEN' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
    expect(res.json()[0].walletId).toBeTruthy();
    expect(res.json()[0].currency).toBeTruthy();
    expect(res.json()[0].balance).toBeDefined();
    expect(res.json()[0].status).toBe('ACTIVE');
  });

  it('returns empty array when no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ledger/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
