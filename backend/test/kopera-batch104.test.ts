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
    payload: { email: 'b104@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b104@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment dispute evidence', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates evidence', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-dispute-evidence/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { disputeId: 'disp-1', evidenceType: 'receipt', description: 'Receipt for order' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().disputeId).toBe('disp-1');
    expect(res.json().evidenceType).toBe('RECEIPT');
    expect(res.json().status).toBe('SUBMITTED');
  });

  it('lists evidence', async () => {
    await ctx.prisma.paymentDisputeEvidence.create({
      data: { userId: ctx.user.id, disputeId: 'disp-2', evidenceType: 'INVOICE', description: 'Invoice copy' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-dispute-evidence/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('reviews evidence', async () => {
    const e = await ctx.prisma.paymentDisputeEvidence.create({
      data: { userId: ctx.user.id, disputeId: 'disp-3', evidenceType: 'PHOTO', description: 'Photo proof', status: 'SUBMITTED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-dispute-evidence/${e.id}/review`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('UNDER_REVIEW');
  });

  it('accepts evidence', async () => {
    const e = await ctx.prisma.paymentDisputeEvidence.create({
      data: { userId: ctx.user.id, disputeId: 'disp-4', evidenceType: 'DOC', description: 'Document', status: 'UNDER_REVIEW' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-dispute-evidence/${e.id}/accept`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACCEPTED');
  });

  it('rejects evidence', async () => {
    const e = await ctx.prisma.paymentDisputeEvidence.create({
      data: { userId: ctx.user.id, disputeId: 'disp-5', evidenceType: 'VIDEO', description: 'Video proof', status: 'UNDER_REVIEW' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-dispute-evidence/${e.id}/reject`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Insufficient quality' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
    expect(res.json().rejectionReason).toBe('Insufficient quality');
  });

  it('returns no_data evidence analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-dispute-evidence/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEvidence).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('customer segments', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a segment', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/customer-segments/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'High Value', criteria: 'total_spend > 100000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('High Value');
    expect(res.json().isActive).toBe(true);
    expect(res.json().memberCount).toBe(0);
  });

  it('rejects duplicate segment name', async () => {
    await ctx.prisma.customerSegment.create({
      data: { userId: ctx.user.id, name: 'VIP', criteria: 'tier=gold' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/customer-segments/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'VIP', criteria: 'tier=gold' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('lists segments', async () => {
    await ctx.prisma.customerSegment.create({
      data: { userId: ctx.user.id, name: 'New Users', criteria: 'days_since_signup < 30' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/customer-segments/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('adds members', async () => {
    const s = await ctx.prisma.customerSegment.create({
      data: { userId: ctx.user.id, name: 'Active', criteria: 'last_login < 7d', isActive: true, memberCount: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/customer-segments/${s.id}/add-members`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { count: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().memberCount).toBe(15);
  });

  it('toggles a segment off', async () => {
    const s = await ctx.prisma.customerSegment.create({
      data: { userId: ctx.user.id, name: 'Toggle', criteria: 'any', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/customer-segments/${s.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a segment', async () => {
    const s = await ctx.prisma.customerSegment.create({
      data: { userId: ctx.user.id, name: 'Remove', criteria: 'x' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/customer-segments/${s.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data segment analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/customer-segments/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSegments).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment corridors', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a corridor', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-corridors/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { sourceCurrency: 'USD', targetCurrency: 'EUR', feePercentage: 0.5, minAmount: '1000', maxAmount: '1000000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sourceCurrency).toBe('USD');
    expect(res.json().targetCurrency).toBe('EUR');
    expect(res.json().minAmount).toBe('1000');
    expect(res.json().maxAmount).toBe('1000000');
    expect(res.json().totalVolume).toBe('0');
  });

  it('lists corridors', async () => {
    await ctx.prisma.paymentCorridor.create({
      data: { userId: ctx.user.id, sourceCurrency: 'GBP', targetCurrency: 'USD', feePercentage: 0.3, minAmount: BigInt(500), maxAmount: BigInt(500000) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-corridors/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records a transaction', async () => {
    const c = await ctx.prisma.paymentCorridor.create({
      data: { userId: ctx.user.id, sourceCurrency: 'USD', targetCurrency: 'MXN', feePercentage: 1.0, minAmount: BigInt(100), maxAmount: BigInt(100000), isActive: true, transactionCount: 0, totalVolume: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-corridors/${c.id}/record`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '25000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionCount).toBe(1);
    expect(res.json().totalVolume).toBe('25000');
  });

  it('updates fee', async () => {
    const c = await ctx.prisma.paymentCorridor.create({
      data: { userId: ctx.user.id, sourceCurrency: 'EUR', targetCurrency: 'GBP', feePercentage: 0.5, minAmount: BigInt(100), maxAmount: BigInt(50000) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-corridors/${c.id}/fee`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { feePercentage: 0.75 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feePercentage).toBe(0.75);
  });

  it('toggles a corridor off', async () => {
    const c = await ctx.prisma.paymentCorridor.create({
      data: { userId: ctx.user.id, sourceCurrency: 'USD', targetCurrency: 'JPY', feePercentage: 0.8, minAmount: BigInt(1000), maxAmount: BigInt(200000), isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-corridors/${c.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a corridor', async () => {
    const c = await ctx.prisma.paymentCorridor.create({
      data: { userId: ctx.user.id, sourceCurrency: 'CAD', targetCurrency: 'USD', feePercentage: 0.2, minAmount: BigInt(500), maxAmount: BigInt(100000) },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-corridors/${c.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data corridor analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-corridors/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCorridors).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
