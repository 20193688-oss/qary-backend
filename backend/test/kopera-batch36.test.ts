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
    payload: { email: 'b36@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b36@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('notification engagement report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns engagement after notifications', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'alert', channel: 'EMAIL', body: 'Test email' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'promo', channel: 'PUSH', body: 'Test push' },
    });

    const list = await ctx.app.inject({
      method: 'GET', url: '/api/notifications',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const notifId = list.json()[0].id;
    await ctx.app.inject({
      method: 'POST', url: `/api/notifications/${notifId}/read`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/engagement-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(2);
    expect(body.totalRead).toBe(1);
    expect(typeof body.overallReadRate).toBe('number');
    expect(body.byType).toBeDefined();
    expect(body.byChannel).toBeDefined();
    expect(body.peakEngagementHours).toBeInstanceOf(Array);
  });

  it('returns empty engagement with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/engagement-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.overallReadRate).toBe(0);
  });
});

describe('dispute risk assessment', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns risk after disputes', async () => {
    const gp = await (ctx.prisma as any).gatewayPayment.create({
      data: {
        transactionId: 'tx-risk',
        gateway: 'stripe',
        externalId: 'ext-risk',
        userId: ctx.user.id,
        amount: BigInt(5000),
        currency: 'USD',
        status: 'COMPLETED',
      },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayPaymentId: gp.id, reason: 'fraud', amount: 50, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(1);
    expect(typeof body.totalAmount).toBe('string');
    expect(typeof body.riskScore).toBe('number');
    expect(typeof body.riskLevel).toBe('string');
    expect(body.byStatus).toBeDefined();
  });

  it('returns low risk with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/risk-assessment',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.riskLevel).toBe('low');
    expect(body.riskScore).toBe(0);
  });
});

describe('payment link revenue breakdown', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns breakdown after creating links', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD', description: 'Single use link', singleUse: true },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'PEN', description: 'Multi use link', singleUse: false },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/revenue-breakdown',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(2);
    expect(typeof body.totalRevenue).toBe('string');
    expect(body.byCurrency).toBeDefined();
    expect(body.singleUse.count).toBe(1);
    expect(body.multiUse.count).toBe(1);
    expect(typeof body.activeRevenue).toBe('string');
  });

  it('returns empty breakdown with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/revenue-breakdown',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.totalRevenue).toBe('0');
  });
});

describe('savings goals health', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns health after creating goals', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation', targetAmount: 1000, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Car', targetAmount: 5000, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(2);
    expect(body.activeGoals).toBe(2);
    expect(typeof body.healthScore).toBe('number');
    expect(typeof body.overallProgress).toBe('number');
    expect(typeof body.totalSaved).toBe('string');
    expect(typeof body.totalTarget).toBe('string');
    expect(body.goals).toBeInstanceOf(Array);
    expect(body.goals).toHaveLength(2);
  });

  it('returns empty health with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.healthScore).toBe(0);
  });
});

describe('subscription cost optimization', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns optimization after subscriptions', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 29.99, currency: 'USD', interval: 'monthly' },
    });
    const sub2 = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Storage', amount: 9.99, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${sub2.json().id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/cost-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeSubscriptions).toBe(1);
    expect(body.pausedCount).toBe(1);
    expect(typeof body.monthlySpend).toBe('string');
    expect(typeof body.pausedMonthlySavings).toBe('string');
    expect(body.recommendations).toBeInstanceOf(Array);
    expect(body.recommendations.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty optimization with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/cost-optimization',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeSubscriptions).toBe(0);
    expect(body.monthlySpend).toBe('0');
    expect(body.recommendations).toHaveLength(0);
  });
});
