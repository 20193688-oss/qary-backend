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
    payload: { email: 'b29@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b29@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

async function bootstrapTwo() {
  const ctx = await bootstrap();
  const reg2 = await ctx.app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'b29-r@kopera.io' },
  });
  const v2 = await ctx.app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b29-r@kopera.io', code: reg2.json().debugOtp },
  });
  return { ...ctx, recipient: v2.json().user };
}

describe('fx conversion history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns conversion history after FX transactions', async () => {
    await ctx.prisma.fxRate.create({
      data: { baseCurrency: 'USD', quoteCurrency: 'EUR', bid: 0.90, ask: 0.92, mid: 0.91, spread: 0.02, spreadBps: 200, source: 'test' },
    });
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(1000000), availableBalance: BigInt(1000000), status: 'ACTIVE', isDefault: true },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'EUR' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConversions).toBe(1);
    expect(Object.keys(res.json().byPair)).toContain('USD/EUR');
  });

  it('returns empty history with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConversions).toBe(0);
  });
});

describe('beneficiary overview', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTwo>>;
  beforeEach(async () => { ctx = await bootstrapTwo(); });

  it('returns overview after adding beneficiaries', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Friend', recipientUserId: ctx.recipient.id, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalBeneficiaries).toBe(1);
    expect(res.json().byCurrency.USD).toBe(1);
    expect(res.json().addedLast30Days).toBe(1);
  });

  it('returns empty overview with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalBeneficiaries).toBe(0);
  });
});

describe('bank account verification overview', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns overview after adding accounts', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'Test Bank', accountNumber: '1234567890', rail: 'ACH', country: 'US', currency: 'USD', holderName: 'Test User' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'BBVA', accountNumber: '9876543210', rail: 'SPEI', country: 'MX', currency: 'MXN', holderName: 'Test User' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/verification-overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalAccounts).toBe(2);
    expect(res.json().unverified).toBe(2);
    expect(res.json().byRail.ACH).toBe(1);
    expect(res.json().byCountry.MX).toBe(1);
  });

  it('returns empty overview with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/verification-overview',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalAccounts).toBe(0);
    expect(res.json().verificationRate).toBe(0);
  });
});

describe('scheduled transfer execution history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTwo>>;
  beforeEach(async () => { ctx = await bootstrapTwo(); });

  it('returns history after creating transfers', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: ctx.recipient.id, currency: 'USD', amount: 50, frequency: 'weekly', description: 'Rent share' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/execution-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfers).toHaveLength(1);
    expect(res.json().transfers[0].currency).toBe('USD');
    expect(res.json().transfers[0].frequency).toBe('weekly');
    expect(typeof res.json().transfers[0].amountPerExecution).toBe('string');
  });

  it('returns empty history with no transfers', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers/execution-history',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalExecutions).toBe(0);
    expect(res.json().transfers).toHaveLength(0);
  });
});

describe('notification delivery report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns report after sending notifications', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'ALERT', channel: 'EMAIL', subject: 'Test', body: 'Hello' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'PROMO', channel: 'PUSH', body: 'Promo msg' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/delivery-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
    expect(res.json().byChannel.EMAIL.total).toBe(1);
    expect(res.json().byChannel.PUSH.total).toBe(1);
  });

  it('returns empty report with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/delivery-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
  });
});
