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
    payload: { email: 'b101@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b101@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('merchant settlements', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a settlement', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-settlements/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { merchantName: 'ShopCo', merchantId: 'M-001', amount: '500000', currency: 'USD', settlementPeriod: '2025-Q1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().merchantName).toBe('ShopCo');
    expect(res.json().amount).toBe('500000');
    expect(res.json().status).toBe('PENDING');
  });

  it('lists settlements', async () => {
    await ctx.prisma.merchantSettlement.create({
      data: { userId: ctx.user.id, merchantName: 'Test', merchantId: 'M-X', amount: BigInt(10000), currency: 'USD', settlementPeriod: 'Q1', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-settlements/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('processes a settlement', async () => {
    const s = await ctx.prisma.merchantSettlement.create({
      data: { userId: ctx.user.id, merchantName: 'Proc', merchantId: 'M-P', amount: BigInt(200000), currency: 'USD', settlementPeriod: 'Q2', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-settlements/${s.id}/process`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PROCESSING');
  });

  it('completes a settlement', async () => {
    const s = await ctx.prisma.merchantSettlement.create({
      data: { userId: ctx.user.id, merchantName: 'Done', merchantId: 'M-D', amount: BigInt(300000), currency: 'USD', settlementPeriod: 'Q3', status: 'PROCESSING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-settlements/${s.id}/complete`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('COMPLETED');
  });

  it('cancels a settlement', async () => {
    const s = await ctx.prisma.merchantSettlement.create({
      data: { userId: ctx.user.id, merchantName: 'Cancel', merchantId: 'M-C', amount: BigInt(100000), currency: 'EUR', settlementPeriod: 'Q4', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-settlements/${s.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data settlement analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-settlements/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSettlements).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment schedules', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payment schedule', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-schedules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Car Loan', recipientName: 'Bank', recipientAccount: 'BK-001', amount: '50000', currency: 'USD', frequency: 'MONTHLY', startDate: '2025-01-01T00:00:00Z', installments: 12 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Car Loan');
    expect(res.json().amount).toBe('50000');
    expect(res.json().totalInstallments).toBe(12);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('lists payment schedules', async () => {
    await ctx.prisma.paymentSchedule.create({
      data: { userId: ctx.user.id, name: 'Test', recipientName: 'R', recipientAccount: 'A', amount: BigInt(5000), currency: 'USD', frequency: 'MONTHLY', startDate: new Date(), totalInstallments: 6, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-schedules/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('executes an installment', async () => {
    const s = await ctx.prisma.paymentSchedule.create({
      data: { userId: ctx.user.id, name: 'Exec', recipientName: 'R', recipientAccount: 'A', amount: BigInt(10000), currency: 'USD', frequency: 'MONTHLY', startDate: new Date(), totalInstallments: 3, completedInstallments: 0, totalPaid: BigInt(0), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-schedules/${s.id}/execute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completedInstallments).toBe(1);
    expect(res.json().totalPaid).toBe('10000');
  });

  it('pauses a schedule', async () => {
    const s = await ctx.prisma.paymentSchedule.create({
      data: { userId: ctx.user.id, name: 'Pause', recipientName: 'R', recipientAccount: 'A', amount: BigInt(5000), currency: 'USD', frequency: 'WEEKLY', startDate: new Date(), totalInstallments: 10, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-schedules/${s.id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAUSED');
  });

  it('resumes a paused schedule', async () => {
    const s = await ctx.prisma.paymentSchedule.create({
      data: { userId: ctx.user.id, name: 'Resume', recipientName: 'R', recipientAccount: 'A', amount: BigInt(5000), currency: 'USD', frequency: 'MONTHLY', startDate: new Date(), totalInstallments: 10, status: 'PAUSED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-schedules/${s.id}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('cancels a schedule', async () => {
    const s = await ctx.prisma.paymentSchedule.create({
      data: { userId: ctx.user.id, name: 'Cancel', recipientName: 'R', recipientAccount: 'A', amount: BigInt(3000), currency: 'GBP', frequency: 'YEARLY', startDate: new Date(), totalInstallments: 5, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-schedules/${s.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data schedule analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-schedules/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSchedules).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('chargebacks', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('files a chargeback', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/chargebacks/file',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionRef: 'TX-001', amount: '75000', currency: 'USD', reason: 'Unauthorized charge', cardLast4: '4242' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transactionRef).toBe('TX-001');
    expect(res.json().amount).toBe('75000');
    expect(res.json().status).toBe('FILED');
  });

  it('lists chargebacks', async () => {
    await ctx.prisma.chargeback.create({
      data: { userId: ctx.user.id, transactionRef: 'TX-X', amount: BigInt(5000), currency: 'USD', reason: 'Test', cardLast4: '1234', status: 'FILED' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/chargebacks/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('submits evidence', async () => {
    const cb = await ctx.prisma.chargeback.create({
      data: { userId: ctx.user.id, transactionRef: 'TX-E', amount: BigInt(30000), currency: 'USD', reason: 'Fraud', cardLast4: '5678', status: 'FILED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/chargebacks/${cb.id}/evidence`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { evidence: 'Receipt and shipping proof attached' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('UNDER_REVIEW');
    expect(res.json().evidence).toBe('Receipt and shipping proof attached');
  });

  it('resolves a chargeback as won', async () => {
    const cb = await ctx.prisma.chargeback.create({
      data: { userId: ctx.user.id, transactionRef: 'TX-R', amount: BigInt(20000), currency: 'USD', reason: 'Dispute', cardLast4: '9999', status: 'UNDER_REVIEW' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/chargebacks/${cb.id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { outcome: 'WON' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('WON');
    expect(res.json().outcome).toBe('WON');
  });

  it('cancels a chargeback', async () => {
    const cb = await ctx.prisma.chargeback.create({
      data: { userId: ctx.user.id, transactionRef: 'TX-C', amount: BigInt(10000), currency: 'EUR', reason: 'Mistake', cardLast4: '0000', status: 'FILED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/chargebacks/${cb.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data chargeback analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/chargebacks/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalChargebacks).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
