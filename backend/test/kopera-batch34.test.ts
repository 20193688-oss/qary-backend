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
    payload: { email: 'b34@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b34@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('beneficiary transfer readiness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  let recipientId: string;
  beforeEach(async () => {
    ctx = await bootstrap();
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'recip34@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'recip34@kopera.io', code: reg2.json().debugOtp },
    });
    recipientId = v2.json().user.id;
  });

  it('returns readiness with funded wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 100 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Alice', recipientUserId: recipientId, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/transfer-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(1);
    expect(body.readyCount).toBe(1);
    expect(body.notReadyCount).toBe(0);
    expect(body.ready).toHaveLength(1);
    expect(body.ready[0].nickname).toBe('Alice');
  });

  it('returns not-ready when no currency set', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Bob', recipientUserId: recipientId },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/transfer-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(1);
    expect(body.readyCount).toBe(0);
    expect(body.notReadyCount).toBe(1);
    expect(body.notReady[0].reason).toBe('no_currency_set');
  });
});

describe('bank account payout readiness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns readiness with verified account', async () => {
    const add = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        bankName: 'TestBank', accountNumber: '1234567890', rail: 'ACH',
        country: 'US', currency: 'USD', holderName: 'Test User',
      },
    });
    const acctId = add.json().id;
    await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acctId}/verify`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/payout-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(1);
    expect(body.readyCount).toBe(1);
    expect(body.pendingCount).toBe(0);
    expect(body.countryCoverage).toContain('US');
    expect(body.railCoverage).toContain('ACH');
  });

  it('returns pending for unverified account', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        bankName: 'PendingBank', accountNumber: '9876543210', rail: 'SEPA',
        country: 'DE', currency: 'EUR', holderName: 'Test User',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/payout-readiness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.readyCount).toBe(0);
    expect(body.pendingCount).toBe(1);
    expect(body.pendingAccounts[0].reason).toBe('not_verified');
  });
});

describe('fx spread analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns analysis after fx conversion', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 500 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'PEN' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/spread-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(1);
    expect(typeof body.totalVolume).toBe('string');
    expect(body.bestRate).toBeDefined();
    expect(body.worstRate).toBeDefined();
  });

  it('returns empty analysis with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/spread-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.totalVolume).toBe('0');
  });
});

describe('session device report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns report after creating sessions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        deviceId: 'dev-1', deviceName: 'iPhone 15', ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0', expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        deviceId: 'dev-2', deviceName: 'MacBook Pro', ip: '10.0.0.1',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/device-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDevices).toBe(2);
    expect(body.totalSessions).toBe(2);
    expect(body.suspiciousDevices).toBe(0);
    expect(body.devices).toHaveLength(2);
  });

  it('returns empty report with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/device-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDevices).toBe(0);
    expect(body.totalSessions).toBe(0);
  });
});

describe('tokenized card expiry forecast', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns forecast with cards', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        vaultToken: 'tok_1', last4: '4242', network: 'VISA',
        expiryMonth: 12, expiryYear: 2030, holderName: 'Test',
      },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        vaultToken: 'tok_2', last4: '5555', network: 'MASTERCARD',
        expiryMonth: 1, expiryYear: 2025, holderName: 'Test',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/expiry-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(2);
    expect(body.expired).toBeGreaterThanOrEqual(1);
    expect(body.urgency).toBe('critical');
    expect(body.expiredCards).toBeInstanceOf(Array);
  });

  it('returns ok urgency with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/expiry-forecast',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.urgency).toBe('ok');
  });
});
