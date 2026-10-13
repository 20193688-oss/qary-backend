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
    payload: { email: 'b46@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b46@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('subscriptions billing health', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns healthy state with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/billing-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.healthScore).toBe(100);
    expect(body.rating).toBe('excellent');
    expect(body.atRiskCount).toBe(0);
  });

  it('detects at-risk subscriptions', async () => {
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'Basic', amount: BigInt(1000),
        currency: 'USD', interval: 'monthly', intervalCount: 1,
        status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(),
        nextBillingDate: new Date(), retryCount: 0,
      },
    });
    await ctx.prisma.subscription.create({
      data: {
        userId: ctx.user.id, planName: 'Premium', amount: BigInt(5000),
        currency: 'USD', interval: 'monthly', intervalCount: 1,
        status: 'past_due', currentPeriodStart: new Date(), currentPeriodEnd: new Date(),
        nextBillingDate: new Date(), retryCount: 3,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/billing-health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(2);
    expect(body.pastDueCount).toBe(1);
    expect(body.atRiskCount).toBe(1);
    expect(body.failureRate).toBeGreaterThan(0);
    expect(body.healthScore).toBeLessThan(100);
    expect(body.rating).toBeDefined();
  });
});

describe('tokenized-cards network diversification', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns none coverage with no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/network-diversification',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(0);
    expect(body.coverage).toBe('none');
    expect(body.dominantNetwork).toBeNull();
  });

  it('analyzes diversification after adding cards', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_1', last4: '1111', network: 'VISA', expiryMonth: 12, expiryYear: 2028 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_2', last4: '2222', network: 'MASTERCARD', expiryMonth: 6, expiryYear: 2029 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_3', last4: '3333', network: 'VISA', expiryMonth: 3, expiryYear: 2027 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/network-diversification',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCards).toBe(3);
    expect(body.distinctNetworks).toBe(2);
    expect(body.coverage).toBe('limited');
    expect(body.dominantNetwork).toBe('VISA');
    expect(body.concentrationIndex).toBeGreaterThan(0);
    expect(body.byNetwork.length).toBe(2);
  });
});

describe('transactions recurring patterns', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty patterns with no transactions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/recurring-patterns',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(0);
    expect(body.patternsDetected).toBe(0);
    expect(body.patterns).toBeInstanceOf(Array);
  });

  it('detects recurring patterns', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(100000), status: 'ACTIVE', isDefault: true },
    });

    const baseDate = new Date();
    for (let i = 0; i < 3; i++) {
      const txDate = new Date(baseDate.getTime() - i * 7 * 24 * 60 * 60 * 1000);
      await ctx.prisma.transaction.create({
        data: {
          userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED',
          amount: BigInt(2000), currency: 'USD', counterpartyName: 'Netflix',
          senderWalletId: wallet.id, createdAt: txDate,
        },
      });
    }
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'DEPOSIT', status: 'COMPLETED',
        amount: BigInt(50000), currency: 'USD', counterpartyName: 'Employer',
        receiverWalletId: wallet.id,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/recurring-patterns',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransactions).toBe(4);
    expect(body.patternsDetected).toBeGreaterThanOrEqual(1);
    expect(body.patterns[0].counterparty).toBe('Netflix');
    expect(body.patterns[0].occurrences).toBe(3);
    expect(body.patterns[0].estimatedFrequency).toBeDefined();
  });
});

describe('user-sessions geo distribution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty distribution with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/geo-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(0);
    expect(body.uniqueLocations).toBe(0);
    expect(body.primaryIp).toBeNull();
  });

  it('analyzes distribution after creating sessions', async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-1', ip: '192.168.1.1', expiresAt: futureDate },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-2', ip: '192.168.1.1', expiresAt: futureDate },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-3', ip: '10.0.0.1', expiresAt: futureDate },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/geo-distribution',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(3);
    expect(body.uniqueLocations).toBe(2);
    expect(body.primaryIp).toBe('192.168.1.1');
    expect(body.concentrationPercent).toBeGreaterThan(50);
    expect(body.byIp.length).toBe(2);
  });
});

describe('user-sessions lifecycle', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zeros with no sessions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/lifecycle',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(0);
    expect(body.avgDurationHours).toBe(0);
    expect(body.manualRevocationRate).toBe(0);
  });

  it('calculates lifecycle after sessions with varied states', async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const s1 = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-a', ip: '1.2.3.4', expiresAt: futureDate },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { deviceId: 'dev-b', ip: '5.6.7.8', expiresAt: futureDate },
    });

    await ctx.app.inject({
      method: 'POST', url: `/api/sessions/${s1.json().id}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/sessions/lifecycle',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSessions).toBe(2);
    expect(body.revokedCount).toBe(1);
    expect(body.activeCount).toBe(1);
    expect(body.manualRevocationRate).toBe(50);
    expect(body.avgDurationHours).toBeGreaterThanOrEqual(0);
  });
});
