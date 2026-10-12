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
    payload: { email: 'b24@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b24@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('event stats', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns event counts by type', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'user', eventType: 'test.action', payload: {} },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/events',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { actor: 'system', eventType: 'test.action', payload: {}, severity: 'WARNING' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEvents).toBeGreaterThanOrEqual(2);
    expect(res.json().byEventType['test.action']).toBeGreaterThanOrEqual(2);
    expect(res.json().byActor.user).toBeGreaterThanOrEqual(1);
  });

  it('returns valid structure with no custom events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('totalEvents');
    expect(res.json()).toHaveProperty('byEventType');
    expect(res.json()).toHaveProperty('bySeverity');
    expect(res.json()).toHaveProperty('byActor');
  });
});

describe('gateway payment stats', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns payment statistics', async () => {
    const txn1 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED',
        amount: BigInt(10000), currency: 'USD', reference: 'GW-T1',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn1.id, status: 'CAPTURED', paymentMethod: 'CARD',
        amount: BigInt(10000), currency: 'USD', gatewayFee: BigInt(320),
        idempotencyKey: 'idem-1',
      },
    });
    const txn2 = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED',
        amount: BigInt(5000), currency: 'USD', reference: 'GW-T2',
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        transactionId: txn2.id, status: 'CAPTURED', paymentMethod: 'WALLET',
        amount: BigInt(5000), currency: 'USD', gatewayFee: BigInt(50),
        idempotencyKey: 'idem-2',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payments/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPayments).toBe(2);
    expect(Number(res.json().totalVolume)).toBeGreaterThan(0);
    expect(Number(res.json().totalFees)).toBeGreaterThan(0);
    expect(res.json().byMethod.CARD).toBe(1);
    expect(res.json().byMethod.WALLET).toBe(1);
  });

  it('returns zeros when no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/payments/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPayments).toBe(0);
    expect(res.json().totalVolume).toBe('0');
  });
});

describe('subscription spending summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns monthly burn summary', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Netflix', amount: 15, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Spotify', amount: 10, currency: 'USD', interval: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeCount).toBe(2);
    expect(Number(res.json().monthlyBurnByCurrency.USD)).toBeGreaterThan(0);
    expect(res.json().mostExpensive.planName).toBe('Netflix');
    expect(res.json().byStatus.active).toBe(2);
  });

  it('returns zeros when no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeCount).toBe(0);
    expect(res.json().mostExpensive).toBeNull();
  });
});

describe('bank account update', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('updates bank account fields', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        bankName: 'Old Bank', accountNumber: '1234567890', rail: 'ACH',
        country: 'US', currency: 'USD', holderName: 'John Doe',
      },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/bank-accounts/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { holderName: 'Jane Doe', bankName: 'New Bank' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().holderName).toBe('Jane Doe');
    expect(res.json().id).toBe(id);
  });

  it('returns 404 for nonexistent account', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/bank-accounts/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { holderName: 'Test' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('points calculator', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('calculates points for a transaction', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/calculate?amount=100&type=PAYMENT',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pointsToEarn).toBeGreaterThan(0);
    expect(res.json().currentTier).toBeTruthy();
    expect(res.json().type).toBe('PAYMENT');
  });

  it('returns zero for zero amount', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/points/calculate?amount=0',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pointsToEarn).toBe(0);
  });
});
