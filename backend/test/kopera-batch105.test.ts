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
    payload: { email: 'b105@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b105@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('settlement reports', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a report', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/settlement-reports/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-30T23:59:59Z', currency: 'USD', totalSettled: '5000000', transactionCount: 150 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalSettled).toBe('5000000');
    expect(res.json().status).toBe('GENERATED');
    expect(res.json().transactionCount).toBe(150);
  });

  it('lists reports', async () => {
    await ctx.prisma.settlementReport.create({
      data: { userId: ctx.user.id, periodStart: new Date(), periodEnd: new Date(), currency: 'USD', totalSettled: BigInt(100000), transactionCount: 10 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/settlement-reports/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('finalizes a report', async () => {
    const r = await ctx.prisma.settlementReport.create({
      data: { userId: ctx.user.id, periodStart: new Date(), periodEnd: new Date(), currency: 'EUR', totalSettled: BigInt(200000), transactionCount: 25, status: 'GENERATED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/settlement-reports/${r.id}/finalize`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FINALIZED');
  });

  it('archives a report', async () => {
    const r = await ctx.prisma.settlementReport.create({
      data: { userId: ctx.user.id, periodStart: new Date(), periodEnd: new Date(), currency: 'GBP', totalSettled: BigInt(300000), transactionCount: 50, status: 'FINALIZED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/settlement-reports/${r.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARCHIVED');
  });

  it('returns no_data report analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/settlement-reports/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalReports).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment method configs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a config', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-method-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { methodType: 'card', provider: 'Stripe', currency: 'USD', minAmount: '100', maxAmount: '1000000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().methodType).toBe('CARD');
    expect(res.json().provider).toBe('Stripe');
    expect(res.json().minAmount).toBe('100');
    expect(res.json().maxAmount).toBe('1000000');
  });

  it('lists configs', async () => {
    await ctx.prisma.paymentMethodConfig.create({
      data: { userId: ctx.user.id, methodType: 'BANK_TRANSFER', provider: 'ACH', currency: 'USD', minAmount: BigInt(500), maxAmount: BigInt(500000) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-method-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('updates limits', async () => {
    const c = await ctx.prisma.paymentMethodConfig.create({
      data: { userId: ctx.user.id, methodType: 'WALLET', provider: 'Internal', currency: 'EUR', minAmount: BigInt(100), maxAmount: BigInt(50000) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-method-configs/${c.id}/limits`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { minAmount: '200', maxAmount: '100000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().minAmount).toBe('200');
    expect(res.json().maxAmount).toBe('100000');
  });

  it('toggles a config off', async () => {
    const c = await ctx.prisma.paymentMethodConfig.create({
      data: { userId: ctx.user.id, methodType: 'CRYPTO', provider: 'Coinbase', currency: 'USD', minAmount: BigInt(1000), maxAmount: BigInt(200000), isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-method-configs/${c.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a config', async () => {
    const c = await ctx.prisma.paymentMethodConfig.create({
      data: { userId: ctx.user.id, methodType: 'CHECK', provider: 'Bank', currency: 'GBP', minAmount: BigInt(500), maxAmount: BigInt(10000) },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-method-configs/${c.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data config analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-method-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConfigs).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('transaction exports', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an export', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-exports/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { format: 'csv', dateFrom: '2026-09-01T00:00:00Z', dateTo: '2026-09-30T23:59:59Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().format).toBe('CSV');
    expect(res.json().status).toBe('PENDING');
  });

  it('lists exports', async () => {
    await ctx.prisma.transactionExport.create({
      data: { userId: ctx.user.id, format: 'JSON', dateFrom: new Date(), dateTo: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-exports/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('processes an export', async () => {
    const e = await ctx.prisma.transactionExport.create({
      data: { userId: ctx.user.id, format: 'CSV', dateFrom: new Date(), dateTo: new Date(), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-exports/${e.id}/process`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recordCount: 500, fileSize: 1024000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('COMPLETED');
    expect(res.json().recordCount).toBe(500);
  });

  it('downloads an export', async () => {
    const e = await ctx.prisma.transactionExport.create({
      data: { userId: ctx.user.id, format: 'PDF', dateFrom: new Date(), dateTo: new Date(), status: 'COMPLETED', downloadCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-exports/${e.id}/download`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().downloadCount).toBe(1);
  });

  it('cancels an export', async () => {
    const e = await ctx.prisma.transactionExport.create({
      data: { userId: ctx.user.id, format: 'XLSX', dateFrom: new Date(), dateTo: new Date(), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-exports/${e.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data export analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-exports/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalExports).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
