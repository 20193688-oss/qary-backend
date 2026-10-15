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
    payload: { email: 'b100@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b100@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('invoice credit notes', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a credit note', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoice-credit-notes/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { invoiceId: 'inv-001', amount: '50000', currency: 'USD', reason: 'Overcharge' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().invoiceId).toBe('inv-001');
    expect(res.json().amount).toBe('50000');
    expect(res.json().status).toBe('ISSUED');
  });

  it('lists credit notes', async () => {
    await ctx.prisma.invoiceCreditNote.create({
      data: { userId: ctx.user.id, invoiceId: 'inv-x', amount: BigInt(10000), currency: 'USD', reason: 'Test', status: 'ISSUED' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoice-credit-notes/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('applies a credit note', async () => {
    const cn = await ctx.prisma.invoiceCreditNote.create({
      data: { userId: ctx.user.id, invoiceId: 'inv-a', amount: BigInt(20000), currency: 'USD', reason: 'Refund', status: 'ISSUED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoice-credit-notes/${cn.id}/apply`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPLIED');
  });

  it('voids a credit note', async () => {
    const cn = await ctx.prisma.invoiceCreditNote.create({
      data: { userId: ctx.user.id, invoiceId: 'inv-b', amount: BigInt(15000), currency: 'EUR', reason: 'Error', status: 'ISSUED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoice-credit-notes/${cn.id}/void`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('VOIDED');
  });

  it('returns no_data credit note analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoice-credit-notes/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalNotes).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('reward programs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a reward program', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/reward-programs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Gold Rewards', programType: 'CASHBACK', pointsPerUnit: 10, currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Gold Rewards');
    expect(res.json().programType).toBe('CASHBACK');
    expect(res.json().isActive).toBe(true);
  });

  it('lists reward programs', async () => {
    await ctx.prisma.rewardProgram.create({
      data: { userId: ctx.user.id, name: 'Test', programType: 'POINTS', pointsPerUnit: 5, currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/reward-programs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('issues points', async () => {
    const p = await ctx.prisma.rewardProgram.create({
      data: { userId: ctx.user.id, name: 'Issue Test', programType: 'POINTS', pointsPerUnit: 1, currency: 'USD', isActive: true, totalPointsIssued: 0, totalPointsRedeemed: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/reward-programs/${p.id}/issue-points`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { points: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPointsIssued).toBe(500);
  });

  it('redeems points', async () => {
    const p = await ctx.prisma.rewardProgram.create({
      data: { userId: ctx.user.id, name: 'Redeem Test', programType: 'POINTS', pointsPerUnit: 1, currency: 'USD', isActive: true, totalPointsIssued: 1000, totalPointsRedeemed: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/reward-programs/${p.id}/redeem-points`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { points: 300 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPointsRedeemed).toBe(300);
  });

  it('rejects redeeming more than available', async () => {
    const p = await ctx.prisma.rewardProgram.create({
      data: { userId: ctx.user.id, name: 'Over Redeem', programType: 'POINTS', pointsPerUnit: 1, currency: 'USD', isActive: true, totalPointsIssued: 100, totalPointsRedeemed: 50 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/reward-programs/${p.id}/redeem-points`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { points: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insufficient_points');
  });

  it('toggles a program off', async () => {
    const p = await ctx.prisma.rewardProgram.create({
      data: { userId: ctx.user.id, name: 'Toggle', programType: 'CASHBACK', pointsPerUnit: 2, currency: 'EUR', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/reward-programs/${p.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a program', async () => {
    const p = await ctx.prisma.rewardProgram.create({
      data: { userId: ctx.user.id, name: 'Delete Me', programType: 'POINTS', pointsPerUnit: 1, currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/reward-programs/${p.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data reward analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/reward-programs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPrograms).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment requests', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payment request', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-requests/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { payerName: 'John Doe', payerEmail: 'john@example.com', amount: '250000', currency: 'USD', description: 'Invoice #42' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().payerName).toBe('John Doe');
    expect(res.json().amount).toBe('250000');
    expect(res.json().status).toBe('PENDING');
  });

  it('lists payment requests', async () => {
    await ctx.prisma.paymentRequest.create({
      data: { userId: ctx.user.id, payerName: 'Test', payerEmail: 't@t.com', amount: BigInt(5000), currency: 'USD', description: 'Test', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-requests/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('marks a request as paid', async () => {
    const pr = await ctx.prisma.paymentRequest.create({
      data: { userId: ctx.user.id, payerName: 'Payer', payerEmail: 'p@x.com', amount: BigInt(100000), currency: 'USD', description: 'Service', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-requests/${pr.id}/mark-paid`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAID');
  });

  it('declines a request', async () => {
    const pr = await ctx.prisma.paymentRequest.create({
      data: { userId: ctx.user.id, payerName: 'Decliner', payerEmail: 'd@x.com', amount: BigInt(30000), currency: 'EUR', description: 'Nope', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-requests/${pr.id}/decline`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DECLINED');
  });

  it('cancels a request', async () => {
    const pr = await ctx.prisma.paymentRequest.create({
      data: { userId: ctx.user.id, payerName: 'Cancel', payerEmail: 'c@x.com', amount: BigInt(20000), currency: 'GBP', description: 'Cancel me', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-requests/${pr.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('sends a reminder', async () => {
    const pr = await ctx.prisma.paymentRequest.create({
      data: { userId: ctx.user.id, payerName: 'Remind', payerEmail: 'r@x.com', amount: BigInt(45000), currency: 'USD', description: 'Remind me', status: 'PENDING', reminderCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-requests/${pr.id}/remind`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reminderCount).toBe(1);
  });

  it('returns no_data payment request analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-requests/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRequests).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
