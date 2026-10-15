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
    payload: { email: 'b106@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b106@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('merchant onboarding', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an application', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-onboarding/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { businessName: 'Acme Corp', businessType: 'retail', contactEmail: 'admin@acme.com', country: 'US' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().businessName).toBe('Acme Corp');
    expect(res.json().businessType).toBe('RETAIL');
    expect(res.json().status).toBe('IN_PROGRESS');
    expect(res.json().completedSteps).toBe(0);
  });

  it('lists applications', async () => {
    await ctx.prisma.merchantOnboarding.create({
      data: { userId: ctx.user.id, businessName: 'Test LLC', businessType: 'SERVICES', contactEmail: 'test@test.com', country: 'GB' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-onboarding/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('advances a step', async () => {
    const a = await ctx.prisma.merchantOnboarding.create({
      data: { userId: ctx.user.id, businessName: 'Step Inc', businessType: 'TECH', contactEmail: 'step@inc.com', country: 'DE', status: 'IN_PROGRESS', completedSteps: 2, totalSteps: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-onboarding/${a.id}/advance`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completedSteps).toBe(3);
    expect(res.json().status).toBe('IN_PROGRESS');
  });

  it('completes on final step', async () => {
    const a = await ctx.prisma.merchantOnboarding.create({
      data: { userId: ctx.user.id, businessName: 'Final Co', businessType: 'FINANCE', contactEmail: 'fin@co.com', country: 'FR', status: 'IN_PROGRESS', completedSteps: 4, totalSteps: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-onboarding/${a.id}/advance`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completedSteps).toBe(5);
    expect(res.json().status).toBe('COMPLETED');
  });

  it('approves a completed application', async () => {
    const a = await ctx.prisma.merchantOnboarding.create({
      data: { userId: ctx.user.id, businessName: 'Approve LLC', businessType: 'RETAIL', contactEmail: 'app@llc.com', country: 'US', status: 'COMPLETED', completedSteps: 5, totalSteps: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-onboarding/${a.id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
  });

  it('rejects an application', async () => {
    const a = await ctx.prisma.merchantOnboarding.create({
      data: { userId: ctx.user.id, businessName: 'Reject Co', businessType: 'OTHER', contactEmail: 'rej@co.com', country: 'MX', status: 'IN_PROGRESS' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-onboarding/${a.id}/reject`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Insufficient documentation' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
    expect(res.json().rejectionReason).toBe('Insufficient documentation');
  });

  it('returns no_data onboarding analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-onboarding/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalApplications).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('transaction categories', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a category', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-categories/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Groceries', icon: 'cart', color: '#4CAF50' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Groceries');
    expect(res.json().totalAmount).toBe('0');
  });

  it('rejects duplicate category', async () => {
    await ctx.prisma.transactionCategory.create({
      data: { userId: ctx.user.id, name: 'Rent', icon: 'home', color: '#FF0000' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-categories/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Rent', icon: 'home', color: '#0000FF' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('categorizes a transaction', async () => {
    const c = await ctx.prisma.transactionCategory.create({
      data: { userId: ctx.user.id, name: 'Food', icon: 'utensils', color: '#FFC107', isActive: true, transactionCount: 0, totalAmount: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-categories/${c.id}/categorize`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '4500' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionCount).toBe(1);
    expect(res.json().totalAmount).toBe('4500');
  });

  it('toggles a category off', async () => {
    const c = await ctx.prisma.transactionCategory.create({
      data: { userId: ctx.user.id, name: 'Travel', icon: 'plane', color: '#2196F3', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-categories/${c.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a category', async () => {
    const c = await ctx.prisma.transactionCategory.create({
      data: { userId: ctx.user.id, name: 'Misc', icon: 'box', color: '#999' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/transaction-categories/${c.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data category analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-categories/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCategories).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payout schedules', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payout schedule', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payout-schedules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recipientName: 'Vendor A', recipientAccount: 'ACC-V', amount: '100000', currency: 'USD', frequency: 'WEEKLY' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipientName).toBe('Vendor A');
    expect(res.json().amount).toBe('100000');
    expect(res.json().totalPaid).toBe('0');
    expect(res.json().status).toBe('ACTIVE');
  });

  it('executes a payout', async () => {
    const s = await ctx.prisma.payoutSchedule.create({
      data: { userId: ctx.user.id, recipientName: 'Vendor B', recipientAccount: 'ACC-B', amount: BigInt(50000), currency: 'USD', frequency: 'MONTHLY', status: 'ACTIVE', executionCount: 0, totalPaid: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payout-schedules/${s.id}/execute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().executionCount).toBe(1);
    expect(res.json().totalPaid).toBe('50000');
  });

  it('pauses a schedule', async () => {
    const s = await ctx.prisma.payoutSchedule.create({
      data: { userId: ctx.user.id, recipientName: 'Vendor C', recipientAccount: 'ACC-C', amount: BigInt(20000), currency: 'EUR', frequency: 'WEEKLY', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payout-schedules/${s.id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAUSED');
  });

  it('resumes a schedule', async () => {
    const s = await ctx.prisma.payoutSchedule.create({
      data: { userId: ctx.user.id, recipientName: 'Vendor D', recipientAccount: 'ACC-D', amount: BigInt(30000), currency: 'GBP', frequency: 'MONTHLY', status: 'PAUSED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payout-schedules/${s.id}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('cancels a schedule', async () => {
    const s = await ctx.prisma.payoutSchedule.create({
      data: { userId: ctx.user.id, recipientName: 'Vendor E', recipientAccount: 'ACC-E', amount: BigInt(10000), currency: 'USD', frequency: 'DAILY', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payout-schedules/${s.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data payout analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payout-schedules/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSchedules).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
