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
    payload: { email: 'b42@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b42@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('notification channel effectiveness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty effectiveness with no notifications', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/channel-effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(0);
    expect(body.channelCount).toBe(0);
    expect(body.channels).toBeInstanceOf(Array);
    expect(body.bestChannel).toBeNull();
    expect(body.recommendations).toBeInstanceOf(Array);
  });

  it('scores channels after sending notifications', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'alert', channel: 'EMAIL', body: 'Test email' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'alert', channel: 'PUSH', body: 'Test push' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/channel-effectiveness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNotifications).toBe(2);
    expect(body.channelCount).toBe(2);
    expect(body.channels.length).toBe(2);
    expect(body.bestChannel).toBeDefined();
  });
});

describe('dispute escalation analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty analysis with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/escalation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.escalatedCount).toBe(0);
    expect(body.nonEscalatedCount).toBe(0);
    expect(body.escalationRate).toBe(0);
    expect(body.reasonBreakdown).toBeInstanceOf(Array);
  });

  it('analyzes escalation patterns', async () => {
    const gp1 = await ctx.prisma.gatewayPayment.create({
      data: { userId: ctx.user.id, gateway: 'stripe', externalId: 'ext1', amount: BigInt(5000), currency: 'USD', status: 'COMPLETED' },
    });
    const gp2 = await ctx.prisma.gatewayPayment.create({
      data: { userId: ctx.user.id, gateway: 'stripe', externalId: 'ext2', amount: BigInt(3000), currency: 'USD', status: 'COMPLETED' },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayPaymentId: gp1.id, reason: 'fraud', amount: 50, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayPaymentId: gp2.id, reason: 'billing_error', amount: 30, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/escalation-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(2);
    expect(body.reasonBreakdown.length).toBe(2);
    expect(body.reasonBreakdown.find((r: any) => r.reason === 'fraud')).toBeDefined();
  });
});

describe('payment link lifecycle analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty analysis with no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/lifecycle-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(0);
    expect(body.activeCount).toBe(0);
    expect(body.usedCount).toBe(0);
    expect(body.abandonmentRate).toBe(0);
    expect(body.currencyBreakdown).toBeInstanceOf(Array);
  });

  it('analyzes lifecycle after creating links', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 25, currency: 'USD', description: 'Test link' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'PEN', description: 'PEN link' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/lifecycle-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLinks).toBe(2);
    expect(body.activeCount).toBe(2);
    expect(body.currencyBreakdown.length).toBe(2);
    expect(body.currencyBreakdown.find((c: any) => c.currency === 'USD')).toBeDefined();
    expect(body.currencyBreakdown.find((c: any) => c.currency === 'PEN')).toBeDefined();
  });
});

describe('savings goal contribution patterns', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty patterns with no goals', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/contribution-patterns',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(0);
    expect(body.goalsWithContributions).toBe(0);
    expect(body.totalContributed).toBe('0');
    expect(body.topPerformers).toBeInstanceOf(Array);
    expect(body.currencyBreakdown).toBeInstanceOf(Array);
  });

  it('analyzes contribution patterns after saving', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation', targetAmount: 1000, currency: 'USD' },
    });

    const listRes = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const goalId = listRes.json()[0].id;

    await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${goalId}/contribute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 200 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/contribution-patterns',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalGoals).toBe(1);
    expect(body.goalsWithContributions).toBe(1);
    expect(Number(body.totalContributed)).toBeGreaterThan(0);
    expect(body.topPerformers.length).toBe(1);
    expect(body.currencyBreakdown.length).toBe(1);
    expect(body.currencyBreakdown[0].currency).toBe('USD');
  });
});

describe('subscription usage timeline', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty timeline with no subscriptions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/usage-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(0);
    expect(body.avgTenureDays).toBe(0);
    expect(body.longestSubscription).toBeNull();
    expect(body.retentionRate).toBe(0);
    expect(body.planBreakdown).toBeInstanceOf(Array);
  });

  it('tracks subscription timeline after creating', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 29.99, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Basic', amount: 9.99, currency: 'USD', interval: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/usage-timeline',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSubscriptions).toBe(2);
    expect(body.byStatus.active).toBe(2);
    expect(body.retentionRate).toBe(100);
    expect(body.longestSubscription).toBeDefined();
    expect(body.planBreakdown.length).toBe(2);
    expect(body.planBreakdown.find((p: any) => p.plan === 'Pro')).toBeDefined();
  });
});
