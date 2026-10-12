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
    payload: { email: 'ops@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'ops@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

async function createSecondUser(ctx: Awaited<ReturnType<typeof bootstrap>>) {
  const reg = await ctx.app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'ops-recipient@kopera.io' },
  });
  const v = await ctx.app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'ops-recipient@kopera.io', code: reg.json().debugOtp },
  });
  return v.json();
}

describe('notification send and delivery tracking', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('sends a notification', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        userId: ctx.user.id,
        type: 'alert',
        channel: 'IN_APP',
        subject: 'Test Alert',
        body: 'This is a test notification',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe('alert');
    expect(body.channel).toBe('IN_APP');
    expect(body.subject).toBe('Test Alert');
    expect(body.body).toBe('This is a test notification');
  });

  it('marks notification as delivered', async () => {
    const send = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'info', body: 'Delivery test' },
    });
    const notifId = send.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/notifications/${notifId}/delivered`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deliveredAt).toBeTruthy();
  });

  it('prevents double delivery', async () => {
    const send = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'info', body: 'Double test' },
    });
    const notifId = send.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/notifications/${notifId}/delivered`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/notifications/${notifId}/delivered`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_delivered');
  });

  it('marks notification as failed', async () => {
    const send = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'info', body: 'Fail test' },
    });
    const notifId = send.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/notifications/${notifId}/failed`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Email bounced' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().failedAt).toBeTruthy();
    expect(res.json().failReason).toBe('Email bounced');
  });

  it('deletes a notification', async () => {
    const send = await ctx.app.inject({
      method: 'POST', url: '/api/notifications/send',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { userId: ctx.user.id, type: 'info', body: 'Delete me' },
    });
    const notifId = send.json().id;

    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/notifications/${notifId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });
});

describe('scheduled transfer execution', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  let recipient: { accessToken: string; user: { id: string } };
  beforeEach(async () => {
    ctx = await bootstrap();
    recipient = await createSecondUser(ctx);
  });

  it('processes due transfers between wallets', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 500, currency: 'USD' },
    });

    const prisma = ctx.prisma as any;
    await prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id,
        toUserId: recipient.user.id,
        currency: 'USD',
        amount: BigInt(10000),
        frequency: 'monthly',
        description: 'Monthly rent',
        status: 'active',
        nextExecutionDate: new Date(Date.now() - 1000),
        lastExecutionDate: null,
        executionCount: 0,
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers/process-due',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.results[0].success).toBe(true);
  });

  it('fails transfer with insufficient funds', async () => {
    const prisma = ctx.prisma as any;
    await prisma.scheduledTransfer.create({
      data: {
        userId: ctx.user.id,
        toUserId: recipient.user.id,
        currency: 'USD',
        amount: BigInt(999999),
        frequency: 'once',
        description: 'Big payment',
        status: 'active',
        nextExecutionDate: new Date(Date.now() - 1000),
        lastExecutionDate: null,
        executionCount: 0,
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers/process-due',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].success).toBe(false);
    expect(res.json().results[0].reason).toBe('insufficient_funds');
  });

  it('returns empty when nothing due', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/scheduled-transfers/process-due',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(0);
  });
});

describe('wallet-backed savings goal funding', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function setupWalletAndGoal() {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 1000, currency: 'USD' },
    });

    const goal = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Vacation', targetAmount: 500, currency: 'USD' },
    });
    return goal.json();
  }

  it('funds savings goal from wallet', async () => {
    const goal = await setupWalletAndGoal();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${goal.id}/fund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentAmount).toBe('10000');
  });

  it('completes goal when funded to target', async () => {
    const goal = await setupWalletAndGoal();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${goal.id}/fund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
  });

  it('fails funding with insufficient wallet balance', async () => {
    const goal = await setupWalletAndGoal();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${goal.id}/fund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 99999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_funds');
  });

  it('fails funding without a wallet', async () => {
    const goal = await ctx.app.inject({
      method: 'POST', url: '/api/savings-goals',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'No Wallet Goal', targetAmount: 100, currency: 'EUR' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/savings-goals/${goal.json().id}/fund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('wallet_not_found');
  });
});
