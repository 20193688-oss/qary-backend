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
    payload: { email: 'b17@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b17@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('notification GET by ID', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns a notification by ID', async () => {
    const send = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'ALERT', channel: 'IN_APP', body: 'Hello test' },
    });
    const nId = send.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/notifications/${nId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(nId);
    expect(res.json().body).toBe('Hello test');
  });

  it('returns 404 for nonexistent notification', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notifications/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('wallet close', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('closes a zero-balance wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/USD/close',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CLOSED');
  });

  it('rejects closing wallet with balance', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/USD/close',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('balance_not_zero');
  });

  it('rejects closing already closed wallet', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/USD/close',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/USD/close',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_closed');
  });
});

describe('subscription list with filters', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists subscriptions with status filter', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Basic', amount: 10, currency: 'USD', interval: 'monthly' },
    });
    const sub2 = await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'Pro', amount: 20, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/subscriptions/${sub2.json().id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const active = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions?status=active',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().length).toBe(1);
    expect(active.json()[0].planName).toBe('Basic');
  });

  it('lists all subscriptions without filter', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'A', amount: 5, currency: 'USD', interval: 'monthly' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { planName: 'B', amount: 10, currency: 'USD', interval: 'weekly' },
    });

    const all = await ctx.app.inject({
      method: 'GET', url: '/api/subscriptions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().length).toBe(2);
  });
});

describe('payment link list with filters', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists payment links with status filter', async () => {
    const link1 = await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/payment-links/${link1.json().id}/deactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const active = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links?status=active',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().length).toBe(1);
  });
});

describe('admin dispute list', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createDispute() {
    const gp = await (ctx.prisma as any).gatewayPayment.create({
      data: {
        transactionId: 'tx-' + Math.random().toString(36).slice(2, 8),
        gateway: 'stripe',
        externalId: 'ext-' + Math.random().toString(36).slice(2, 8),
        amount: BigInt(5000),
        currency: 'USD',
        method: 'CARD',
      },
    });
    return ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayPaymentId: gp.id, reason: 'Unauthorized charge', amount: 50, currency: 'USD' },
    });
  }

  it('lists all disputes (admin)', async () => {
    await createDispute();
    await createDispute();

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/all',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('filters disputes by status', async () => {
    const d = await createDispute();
    await createDispute();

    await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${d.json().id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'WON', notes: 'Refund issued' },
    });

    const opened = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/all?status=OPENED',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().length).toBe(1);
  });
});

describe('admin KYC list', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists all KYC profiles', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'DNI', documentNumber: '12345678',
        documentCountry: 'PE', firstName: 'Test', lastName: 'User',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/all',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].firstName).toBe('Test');
    expect(res.json()[0].status).toBe('IN_REVIEW');
  });

  it('filters KYC profiles by status', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'PASSPORT', documentNumber: 'AB123456',
        documentCountry: 'US', firstName: 'Jane', lastName: 'Doe',
      },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const approved = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/all?status=APPROVED',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().length).toBe(1);
    expect(approved.json()[0].status).toBe('APPROVED');
  });
});
