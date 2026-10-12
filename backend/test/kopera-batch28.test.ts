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
    payload: { email: 'b28@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b28@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('points earning summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns summary after earning points', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 100, reason: 'signup_bonus' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/points/earn',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, amount: 50, reason: 'referral' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/earning-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEarned).toBeGreaterThanOrEqual(150);
    expect(res.json().byReason.signup_bonus.earned).toBe(100);
    expect(res.json().byReason.referral.count).toBe(1);
  });

  it('returns zeros when no points activity', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/earning-summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEarned).toBe(0);
  });
});

describe('tokenized card usage analytics', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns analytics after adding cards', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_1', last4: '4242', network: 'VISA', expiryMonth: 12, expiryYear: 2028, country: 'US' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_2', last4: '5555', network: 'MASTERCARD', expiryMonth: 6, expiryYear: 2027, country: 'MX' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/usage-analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCards).toBe(2);
    expect(res.json().activeCards).toBe(2);
    expect(res.json().byNetwork.VISA).toBe(1);
    expect(res.json().byNetwork.MASTERCARD).toBe(1);
    expect(res.json().defaultCard).toBeDefined();
  });

  it('returns empty analytics with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/usage-analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCards).toBe(0);
    expect(res.json().defaultCard).toBeNull();
  });
});

describe('gateway pending settlements', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns captured payments awaiting settlement', async () => {
    const txn = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id,
        type: 'PAYMENT',
        status: 'COMPLETED',
        amount: BigInt(50000),
        currency: 'USD',
        reference: `GW-test-${Date.now()}`,
        processedAt: new Date(),
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn.id,
        status: 'CAPTURED',
        paymentMethod: 'CARD',
        amount: BigInt(50000),
        currency: 'USD',
        gatewayFee: BigInt(175),
        antifraudScore: 10,
        antifraudDecision: 'APPROVE',
        antifraudDetails: {},
        idempotencyKey: `idem-${Date.now()}`,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/pending-settlements',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBeGreaterThanOrEqual(1);
    expect(Number(res.json().totalPending)).toBeGreaterThan(0);
  });

  it('returns empty when no captured payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/pending-settlements',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
  });
});

describe('business profile completeness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns completeness for a partial profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxId: '20123456789', taxIdType: 'RUC', taxIdCountry: 'PE' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/completeness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completenessPercent).toBeLessThan(100);
    expect(res.json().missingFields.length).toBeGreaterThan(0);
    expect(res.json().filledFields).toBeGreaterThanOrEqual(3);
  });

  it('returns 404 when no profile exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/completeness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('kyc verification progress', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns progress after starting KYC', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'DNI', documentNumber: '12345678',
        documentCountry: 'PE', firstName: 'Juan', lastName: 'Perez',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/verification-progress',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().progressPercent).toBeGreaterThan(0);
    expect(res.json().completedSteps).toBeGreaterThanOrEqual(3);
    expect(res.json().totalSteps).toBe(8);
    expect(res.json().steps).toHaveLength(8);
  });

  it('returns 404 when KYC not started', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/verification-progress',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
