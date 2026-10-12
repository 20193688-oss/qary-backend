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
    payload: { email: 'b40@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b40@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('beneficiary network map', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty network map when no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/network-map',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.activeRecipients).toBe(0);
    expect(body.dormantCount).toBe(0);
    expect(body.byCurrency).toBeDefined();
    expect(body.frequentRecipients).toBeInstanceOf(Array);
    expect(body.dormantBeneficiaries).toBeInstanceOf(Array);
  });

  it('identifies dormant beneficiaries', async () => {
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'b40-recip@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'b40-recip@kopera.io', code: reg2.json().debugOtp },
    });
    const recipientId = v2.json().user.id;

    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'RecipTest', recipientUserId: recipientId, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/network-map',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(1);
    expect(body.dormantCount).toBe(1);
    expect(body.dormantBeneficiaries.length).toBe(1);
    expect(body.byCurrency['USD']).toBe(1);
  });
});

describe('bank account coverage analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty coverage when no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/coverage-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.verifiedCount).toBe(0);
    expect(body.unverifiedCount).toBe(0);
    expect(body.countryCoverage).toBe(0);
    expect(body.railCoverage).toBe(0);
    expect(body.recommendations).toBeInstanceOf(Array);
  });

  it('analyzes coverage with accounts in multiple countries', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'BCP', accountNumber: '1234567890', rail: 'CCI', country: 'PE', currency: 'PEN', holderName: 'Test User' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { bankName: 'Chase', accountNumber: '9876543210', rail: 'ACH', country: 'US', currency: 'USD', holderName: 'Test User' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/coverage-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.unverifiedCount).toBe(2);
    expect(body.countryCoverage).toBe(2);
    expect(body.railCoverage).toBe(2);
    expect(body.byCountry['PE']).toBeDefined();
    expect(body.byCountry['US']).toBeDefined();
    expect(body.byRail['CCI']).toBeDefined();
    expect(body.byRail['ACH']).toBeDefined();
    expect(body.recommendations).toContain('2 account(s) need verification');
  });
});

describe('fx conversion optimizer', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty optimizer when no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-optimizer',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.totalVolume).toBe('0');
    expect(body.pairAnalysis).toBeInstanceOf(Array);
    expect(body.pairAnalysis.length).toBe(0);
    expect(body.recommendations).toBeInstanceOf(Array);
  });

  it('analyzes conversions after fx execution', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 5000 },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/fx/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, fromCurrency: 'USD', toCurrency: 'PEN' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/conversion-optimizer',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(1);
    expect(Number(body.totalVolume)).toBeGreaterThan(0);
    expect(body.pairAnalysis.length).toBe(1);
    expect(body.pairAnalysis[0].pair).toBe('USD/PEN');
    expect(body.pairAnalysis[0].avgRate).toBeGreaterThan(0);
  });
});

describe('session risk assessment', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns low risk for user with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.riskScore).toBeDefined();
    expect(body.riskLevel).toBeDefined();
    expect(typeof body.activeSessions).toBe('number');
    expect(typeof body.totalSessions).toBe('number');
    expect(typeof body.uniqueIps).toBe('number');
    expect(typeof body.uniqueDevices).toBe('number');
    expect(body.riskFactors).toBeInstanceOf(Array);
    expect(body.recommendations).toBeInstanceOf(Array);
  });

  it('scores risk after creating sessions', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-1', ip: '1.2.3.4', expiresAt: future },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-2', ip: '5.6.7.8', expiresAt: future },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(2);
    expect(body.uniqueDevices).toBe(2);
    expect(body.uniqueIps).toBe(2);
    expect(body.riskLevel).toBe('low');
  });
});

describe('tokenized card security posture', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns posture with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/security-posture',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.activeCount).toBe(0);
    expect(body.frozenCount).toBe(0);
    expect(body.expiredCount).toBe(0);
    expect(body.securityScore).toBe(100);
    expect(body.grade).toBe('EXCELLENT');
    expect(body.issues).toBeInstanceOf(Array);
  });

  it('detects issues with expired card', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_1', last4: '1234', network: 'VISA', expiryMonth: 1, expiryYear: 2024 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/security-posture',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(1);
    expect(body.expiredCount).toBe(1);
    expect(body.securityScore).toBeLessThan(100);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.some((i: string) => i.includes('expired'))).toBe(true);
  });
});
