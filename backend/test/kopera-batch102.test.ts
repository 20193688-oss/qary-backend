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
    payload: { email: 'b102@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b102@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('account tiers', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a tier', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/account-tiers/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Premium', level: 2, monthlyFee: '9900', currency: 'USD', transactionLimit: '1000000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Premium');
    expect(res.json().monthlyFee).toBe('9900');
    expect(res.json().isActive).toBe(true);
  });

  it('lists tiers', async () => {
    await ctx.prisma.accountTier.create({
      data: { userId: ctx.user.id, name: 'Basic', level: 1, monthlyFee: BigInt(0), currency: 'USD', transactionLimit: BigInt(50000) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-tiers/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('updates fee', async () => {
    const t = await ctx.prisma.accountTier.create({
      data: { userId: ctx.user.id, name: 'Pro', level: 3, monthlyFee: BigInt(4900), currency: 'USD', transactionLimit: BigInt(500000) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-tiers/${t.id}/fee`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { monthlyFee: '7900' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().monthlyFee).toBe('7900');
  });

  it('toggles a tier off', async () => {
    const t = await ctx.prisma.accountTier.create({
      data: { userId: ctx.user.id, name: 'Toggle', level: 1, monthlyFee: BigInt(0), currency: 'USD', transactionLimit: BigInt(10000), isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-tiers/${t.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a tier', async () => {
    const t = await ctx.prisma.accountTier.create({
      data: { userId: ctx.user.id, name: 'Del', level: 1, monthlyFee: BigInt(0), currency: 'EUR', transactionLimit: BigInt(10000) },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/account-tiers/${t.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data tier analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-tiers/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTiers).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment link templates', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a template', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-link-templates/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Monthly Sub', amount: '2999', currency: 'USD', description: 'Subscription fee' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Monthly Sub');
    expect(res.json().amount).toBe('2999');
    expect(res.json().isActive).toBe(true);
  });

  it('lists templates', async () => {
    await ctx.prisma.paymentLinkTemplate.create({
      data: { userId: ctx.user.id, name: 'Test', amount: BigInt(1000), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-link-templates/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('uses a template', async () => {
    const t = await ctx.prisma.paymentLinkTemplate.create({
      data: { userId: ctx.user.id, name: 'Use Me', amount: BigInt(5000), currency: 'USD', isActive: true, usageCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-link-templates/${t.id}/use`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().usageCount).toBe(1);
  });

  it('toggles a template off', async () => {
    const t = await ctx.prisma.paymentLinkTemplate.create({
      data: { userId: ctx.user.id, name: 'Off', amount: BigInt(1000), currency: 'USD', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-link-templates/${t.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a template', async () => {
    const t = await ctx.prisma.paymentLinkTemplate.create({
      data: { userId: ctx.user.id, name: 'Remove', amount: BigInt(500), currency: 'GBP' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-link-templates/${t.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data template analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-link-templates/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTemplates).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('bank transfer batches', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a batch', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/bank-transfer-batches/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Payroll Jan', currency: 'USD', description: 'January payroll' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Payroll Jan');
    expect(res.json().status).toBe('DRAFT');
    expect(res.json().totalAmount).toBe('0');
  });

  it('adds an item to a batch', async () => {
    const b = await ctx.prisma.bankTransferBatch.create({
      data: { userId: ctx.user.id, name: 'Add', currency: 'USD', status: 'DRAFT', itemCount: 0, totalAmount: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-transfer-batches/${b.id}/add-item`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recipientName: 'Alice', recipientAccount: 'ACC-A', amount: '50000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipientName).toBe('Alice');
    expect(res.json().amount).toBe('50000');
  });

  it('submits a batch', async () => {
    const b = await ctx.prisma.bankTransferBatch.create({
      data: { userId: ctx.user.id, name: 'Submit', currency: 'USD', status: 'DRAFT', itemCount: 2, totalAmount: BigInt(100000) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-transfer-batches/${b.id}/submit`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SUBMITTED');
  });

  it('processes a batch', async () => {
    const b = await ctx.prisma.bankTransferBatch.create({
      data: { userId: ctx.user.id, name: 'Process', currency: 'USD', status: 'SUBMITTED', itemCount: 3, totalAmount: BigInt(150000) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-transfer-batches/${b.id}/process`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('COMPLETED');
    expect(res.json().processedCount).toBe(3);
  });

  it('cancels a batch', async () => {
    const b = await ctx.prisma.bankTransferBatch.create({
      data: { userId: ctx.user.id, name: 'Cancel', currency: 'EUR', status: 'DRAFT', itemCount: 0, totalAmount: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-transfer-batches/${b.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data batch analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-transfer-batches/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalBatches).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
