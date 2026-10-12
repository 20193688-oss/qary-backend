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
    payload: { email: 'b20@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b20@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('notification type and channel filter', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('filters notifications by type', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'alert', body: 'Alert msg' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'promo', body: 'Promo msg' },
    });

    const alerts = await ctx.app.inject({
      method: 'GET', url: '/api/notifications?type=alert',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(alerts.statusCode).toBe(200);
    expect(alerts.json().length).toBe(1);
    expect(alerts.json()[0].type).toBe('alert');
  });

  it('filters notifications by channel', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'alert', channel: 'EMAIL', body: 'Email' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'alert', channel: 'SMS', body: 'SMS' },
    });

    const emails = await ctx.app.inject({
      method: 'GET', url: '/api/notifications?channel=EMAIL',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(emails.statusCode).toBe(200);
    expect(emails.json().length).toBe(1);
    expect(emails.json()[0].channel).toBe('EMAIL');
  });
});

describe('savings goals summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns aggregate summary across all goals', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation', targetAmount: 1000, currency: 'USD' },
    });
    const g2 = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Car', targetAmount: 5000, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${g2.json().id}/contribute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 500 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalGoals).toBe(2);
    expect(res.json().totalTarget).toBe('600000');
    expect(res.json().totalSaved).toBe('50000');
    expect(res.json().overallProgress).toBeGreaterThan(0);
    expect(res.json().byStatus.active).toBe(2);
  });

  it('returns zeros when no goals exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/savings-goals/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalGoals).toBe(0);
    expect(res.json().totalSaved).toBe('0');
  });
});

describe('subscription upcoming billings', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns upcoming billings within window', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 29.99, currency: 'USD', interval: 'monthly' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/upcoming?days=60',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);
    expect(res.json().billings[0].planName).toBe('Pro');
    expect(res.json().totalDue).toBeTruthy();
  });

  it('returns empty when no upcoming billings', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions/upcoming',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
    expect(res.json().totalDue).toBe('0');
  });
});

describe('beneficiary search', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('searches by nickname', async () => {
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'search-target@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'search-target@kopera.io', code: reg2.json().debugOtp },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Alice Smith', recipientUserId: v2.json().user.id },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/search?q=alice',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].nickname).toBe('Alice Smith');
  });

  it('requires query parameter', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/search',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('query_required');
  });
});

describe('scheduled transfers status filter', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('filters transfers by status', async () => {
    const reg2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'st-recipient@kopera.io' },
    });
    const v2 = await ctx.app.inject({
      method: 'POST', url: '/api/auth/verify-otp',
      payload: { email: 'st-recipient@kopera.io', code: reg2.json().debugOtp },
    });

    const st1 = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: v2.json().user.id, currency: 'USD', amount: 50, frequency: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/scheduled-transfers/${st1.json().id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { toUserId: v2.json().user.id, currency: 'USD', amount: 100, frequency: 'weekly' },
    });

    const active = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers?status=active',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().length).toBe(1);
    expect(active.json()[0].frequency).toBe('weekly');

    const cancelled = await ctx.app.inject({
      method: 'GET', url: '/api/scheduled-transfers?status=cancelled',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(cancelled.json().length).toBe(1);
    expect(cancelled.json()[0].frequency).toBe('monthly');
  });
});
