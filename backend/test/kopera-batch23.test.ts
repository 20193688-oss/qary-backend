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
    payload: { email: 'b23@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b23@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('account deactivation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('deactivates the account', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/deactivate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('rejects double deactivation', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/profile/deactivate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/profile/deactivate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_deactivated');
  });
});

describe('kyc expiry check', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 when no KYC profile exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/expiry',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('kyc_not_found');
  });

  it('returns expiry info for approved KYC', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'DNI', documentNumber: '12345678',
        documentCountry: 'PE', firstName: 'Test', lastName: 'User',
      },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/expiry',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expired).toBe(false);
    expect(res.json().status).toBe('APPROVED');
    expect(res.json().daysRemaining).toBeGreaterThan(0);
    expect(res.json().expiresAt).toBeTruthy();
  });
});

describe('referral conversion stats', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty stats when no referral code exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/conversion',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasCode).toBe(false);
    expect(res.json().conversionRate).toBe(0);
  });

  it('returns conversion stats with an active referral code', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/conversion',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasCode).toBe(true);
    expect(res.json().code).toBeTruthy();
    expect(res.json().signupCount).toBe(0);
    expect(res.json().conversionRate).toBe(0);
  });
});

describe('loan early payoff', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 for nonexistent loan', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/loans/nonexistent/early-payoff',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('calculates early payoff for a disbursed loan', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    const applyRes = await ctx.app.inject({
      method: 'POST', url: '/api/loans/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD', termMonths: 6, purpose: 'test' },
    });
    const loanId = applyRes.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/loans/${loanId}/disburse`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/loans/${loanId}/early-payoff`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().loanId).toBe(loanId);
    expect(Number(res.json().payoffAmount)).toBeGreaterThanOrEqual(0);
    expect(res.json().remainingInstallments).toBeGreaterThanOrEqual(0);
    expect(res.json().originalTermMonths).toBe(6);
  });
});

describe('wallet rename', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('renames a wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/wallets/USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { label: 'My Savings' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('USD');
  });

  it('returns 404 for nonexistent wallet', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/wallets/EUR',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { label: 'Euro Wallet' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('wallet_not_found');
  });
});
