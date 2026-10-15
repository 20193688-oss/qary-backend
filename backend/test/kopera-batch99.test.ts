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
    payload: { email: 'b99@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b99@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('direct debits', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a direct debit mandate', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/direct-debits/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { creditorName: 'Netflix', creditorAccount: 'CR-001', amount: '15000', currency: 'USD', frequency: 'MONTHLY' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().creditorName).toBe('Netflix');
    expect(res.json().amount).toBe('15000');
    expect(res.json().status).toBe('ACTIVE');
  });

  it('lists mandates', async () => {
    await ctx.prisma.directDebitMandate.create({
      data: { userId: ctx.user.id, creditorName: 'Test', creditorAccount: 'CR-1', amount: BigInt(10000), currency: 'USD', frequency: 'MONTHLY', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/direct-debits/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('collects a payment', async () => {
    const m = await ctx.prisma.directDebitMandate.create({
      data: { userId: ctx.user.id, creditorName: 'Gym', creditorAccount: 'CR-2', amount: BigInt(5000), currency: 'USD', frequency: 'MONTHLY', status: 'ACTIVE', collectionsCount: 0, totalCollected: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/direct-debits/${m.id}/collect`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().collectionsCount).toBe(1);
    expect(res.json().totalCollected).toBe('5000');
  });

  it('suspends a mandate', async () => {
    const m = await ctx.prisma.directDebitMandate.create({
      data: { userId: ctx.user.id, creditorName: 'ISP', creditorAccount: 'CR-3', amount: BigInt(8000), currency: 'USD', frequency: 'MONTHLY', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/direct-debits/${m.id}/suspend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SUSPENDED');
  });

  it('reactivates a suspended mandate', async () => {
    const m = await ctx.prisma.directDebitMandate.create({
      data: { userId: ctx.user.id, creditorName: 'Phone', creditorAccount: 'CR-4', amount: BigInt(6000), currency: 'USD', frequency: 'MONTHLY', status: 'SUSPENDED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/direct-debits/${m.id}/reactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('cancels a mandate', async () => {
    const m = await ctx.prisma.directDebitMandate.create({
      data: { userId: ctx.user.id, creditorName: 'Old', creditorAccount: 'CR-5', amount: BigInt(3000), currency: 'EUR', frequency: 'WEEKLY', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/direct-debits/${m.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data mandate analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/direct-debits/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalMandates).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('escrows', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an escrow', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/escrows/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { counterpartyName: 'Seller Co', counterpartyEmail: 'seller@co.com', amount: '1000000', currency: 'USD', description: 'Property purchase' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().counterpartyName).toBe('Seller Co');
    expect(res.json().amount).toBe('1000000');
    expect(res.json().status).toBe('FUNDED');
  });

  it('lists escrows', async () => {
    await ctx.prisma.escrow.create({
      data: { userId: ctx.user.id, counterpartyName: 'Test', counterpartyEmail: 'x@y.com', amount: BigInt(50000), currency: 'USD', description: 'Test', status: 'FUNDED' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/escrows/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('releases an escrow', async () => {
    const e = await ctx.prisma.escrow.create({
      data: { userId: ctx.user.id, counterpartyName: 'Seller', counterpartyEmail: 's@b.com', amount: BigInt(200000), currency: 'USD', description: 'Deal', status: 'FUNDED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/escrows/${e.id}/release`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('RELEASED');
  });

  it('disputes an escrow', async () => {
    const e = await ctx.prisma.escrow.create({
      data: { userId: ctx.user.id, counterpartyName: 'Vendor', counterpartyEmail: 'v@b.com', amount: BigInt(150000), currency: 'USD', description: 'Service', status: 'FUNDED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/escrows/${e.id}/dispute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Goods not delivered' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DISPUTED');
    expect(res.json().disputeReason).toBe('Goods not delivered');
  });

  it('refunds an escrow', async () => {
    const e = await ctx.prisma.escrow.create({
      data: { userId: ctx.user.id, counterpartyName: 'Failed', counterpartyEmail: 'f@b.com', amount: BigInt(100000), currency: 'USD', description: 'Refund case', status: 'DISPUTED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/escrows/${e.id}/refund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REFUNDED');
  });

  it('returns no_data escrow analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/escrows/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEscrows).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('standing orders', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a standing order', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/standing-orders/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recipientName: 'Landlord', recipientAccount: 'LL-001', amount: '1500000', currency: 'USD', frequency: 'MONTHLY', startDate: '2025-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipientName).toBe('Landlord');
    expect(res.json().amount).toBe('1500000');
    expect(res.json().status).toBe('ACTIVE');
  });

  it('lists standing orders', async () => {
    await ctx.prisma.standingOrder.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientAccount: 'ACC-1', amount: BigInt(50000), currency: 'USD', frequency: 'WEEKLY', startDate: new Date(), nextExecutionDate: new Date(), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/standing-orders/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('executes a standing order', async () => {
    const o = await ctx.prisma.standingOrder.create({
      data: { userId: ctx.user.id, recipientName: 'Utils', recipientAccount: 'UT-1', amount: BigInt(20000), currency: 'USD', frequency: 'MONTHLY', startDate: new Date(), nextExecutionDate: new Date(), status: 'ACTIVE', executionCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/standing-orders/${o.id}/execute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().executionCount).toBe(1);
  });

  it('pauses a standing order', async () => {
    const o = await ctx.prisma.standingOrder.create({
      data: { userId: ctx.user.id, recipientName: 'Sub', recipientAccount: 'SB-1', amount: BigInt(10000), currency: 'USD', frequency: 'MONTHLY', startDate: new Date(), nextExecutionDate: new Date(), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/standing-orders/${o.id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAUSED');
  });

  it('resumes a paused standing order', async () => {
    const o = await ctx.prisma.standingOrder.create({
      data: { userId: ctx.user.id, recipientName: 'Sub', recipientAccount: 'SB-2', amount: BigInt(10000), currency: 'USD', frequency: 'WEEKLY', startDate: new Date(), nextExecutionDate: new Date(), status: 'PAUSED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/standing-orders/${o.id}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('cancels a standing order', async () => {
    const o = await ctx.prisma.standingOrder.create({
      data: { userId: ctx.user.id, recipientName: 'Old', recipientAccount: 'OLD-1', amount: BigInt(5000), currency: 'GBP', frequency: 'YEARLY', startDate: new Date(), nextExecutionDate: new Date(), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/standing-orders/${o.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data standing order analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/standing-orders/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalOrders).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
