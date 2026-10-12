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
    payload: { email: 'b14@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b14@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

async function createSecondUser(ctx: Awaited<ReturnType<typeof bootstrap>>) {
  const reg = await ctx.app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'b14-other@kopera.io' },
  });
  const v = await ctx.app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b14-other@kopera.io', code: reg.json().debugOtp },
  });
  return v.json();
}

describe('ant-expense enhancements', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createExpense(category: string, merchant: string, monthly: number) {
    return ctx.app.inject({
      method: 'POST', url: '/api/ant-expenses',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        category,
        merchantName: merchant,
        amount: 10,
        currency: 'USD',
        frequency: 'monthly',
        monthlyTotal: monthly,
        yearlyProjection: monthly * 12,
      },
    });
  }

  it('gets expense by id', async () => {
    const created = await createExpense('food', 'McDonalds', 50);
    const id = created.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/ant-expenses/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantName).toBe('McDonalds');
  });

  it('returns 404 for missing expense', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns category breakdown', async () => {
    await createExpense('food', 'McDonalds', 50);
    await createExpense('food', 'Starbucks', 30);
    await createExpense('transport', 'Uber', 100);

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/breakdown/USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(2);
    expect(body[0].category).toBe('transport');
    expect(body[0].count).toBe(1);
    expect(body[1].category).toBe('food');
    expect(body[1].count).toBe(2);
  });

  it('reactivates a dismissed expense', async () => {
    const created = await createExpense('food', 'Pizza Hut', 40);
    const id = created.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/ant-expenses/${id}/dismiss`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/ant-expenses/${id}/reactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(true);
  });

  it('rejects reactivate on active expense', async () => {
    const created = await createExpense('food', 'Subway', 25);
    const id = created.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/ant-expenses/${id}/reactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_active');
  });
});

describe('referral validation and deactivation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('validates an active referral code', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const code = codeRes.json().code;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/referrals/validate/${code}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(res.json().referrerId).toBe(ctx.user.id);
  });

  it('returns invalid for nonexistent code', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/validate/INVALID99',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
    expect(res.json().reason).toBe('not_found');
  });

  it('deactivates a referral code', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/deactivate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('inactive');
  });

  it('rejects applying an inactive code', async () => {
    const codeRes = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const code = codeRes.json().code;

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/deactivate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const other = await createSecondUser(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/apply',
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { code },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('referral_inactive');
  });

  it('reactivates an inactive referral code', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/deactivate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/referrals/activate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
  });
});

describe('session touch and cleanup', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createSession(expiresAt: Date) {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        deviceId: 'dev-' + Math.random().toString(36).slice(2, 6),
        ip: '127.0.0.1',
        expiresAt: expiresAt.toISOString(),
      },
    });
    return res.json();
  }

  it('touches a session to update lastActiveAt', async () => {
    const session = await createSession(new Date(Date.now() + 86400000));

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/sessions/${session.id}/touch`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lastActiveAt).toBeTruthy();
  });

  it('returns 404 for touch on nonexistent session', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/sessions/nonexistent/touch',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cleans up expired sessions', async () => {
    await createSession(new Date(Date.now() - 86400000));
    await createSession(new Date(Date.now() + 86400000));

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/sessions/cleanup-expired',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleaned).toBe(1);
  });

  it('returns zero when nothing expired', async () => {
    await createSession(new Date(Date.now() + 86400000));

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/sessions/cleanup-expired',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleaned).toBe(0);
  });
});

describe('agent execution metrics', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns metrics for executions', async () => {
    const prisma = ctx.prisma as any;
    await prisma.agentExecution.create({
      data: { agentId: 'agent-1', status: 'completed', durationMs: 100, input: {} },
    });
    await prisma.agentExecution.create({
      data: { agentId: 'agent-1', status: 'completed', durationMs: 200, input: {} },
    });
    await prisma.agentExecution.create({
      data: { agentId: 'agent-1', status: 'failed', durationMs: 50, input: {}, errorMsg: 'timeout' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.successRate).toBeCloseTo(66.67, 0);
    expect(body.avgDurationMs).toBe(150);
  });

  it('returns empty metrics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    expect(res.json().successRate).toBe(0);
    expect(res.json().avgDurationMs).toBe(null);
  });

  it('filters metrics by agentId', async () => {
    const prisma = ctx.prisma as any;
    await prisma.agentExecution.create({
      data: { agentId: 'agent-A', status: 'completed', durationMs: 100, input: {} },
    });
    await prisma.agentExecution.create({
      data: { agentId: 'agent-B', status: 'failed', durationMs: 50, input: {} },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/metrics?agentId=agent-A',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().successRate).toBe(100);
  });
});
