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
    payload: { email: 'b111@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b111@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('transaction fraud scores', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a score', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-fraud-scores/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionId: 'tx-001', score: 85, riskLevel: 'high', factors: 'velocity,amount', model: 'v2.1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().riskLevel).toBe('HIGH');
    expect(res.json().score).toBe(85);
    expect(res.json().status).toBe('PENDING_REVIEW');
  });

  it('lists scores', async () => {
    await ctx.prisma.transactionFraudScore.create({
      data: { userId: ctx.user.id, transactionId: 'tx-002', score: 30, riskLevel: 'LOW', factors: 'none', model: 'v1' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-fraud-scores/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('reviews a score', async () => {
    const s = await ctx.prisma.transactionFraudScore.create({
      data: { userId: ctx.user.id, transactionId: 'tx-003', score: 72, riskLevel: 'MEDIUM', factors: 'geo', model: 'v2', status: 'PENDING_REVIEW' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-fraud-scores/${s.id}/review`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { decision: 'approved', reviewedBy: 'analyst-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REVIEWED');
    expect(res.json().decision).toBe('APPROVED');
  });

  it('escalates a score', async () => {
    const s = await ctx.prisma.transactionFraudScore.create({
      data: { userId: ctx.user.id, transactionId: 'tx-004', score: 95, riskLevel: 'CRITICAL', factors: 'all', model: 'v2', status: 'PENDING_REVIEW' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-fraud-scores/${s.id}/escalate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ESCALATED');
  });

  it('returns no_data score analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-fraud-scores/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalScores).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment channel configs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a channel config', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-channel-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { channelName: 'Web Checkout', channelType: 'online', supportedMethods: 'card,wallet', currency: 'usd', feePercent: 2.9 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().channelType).toBe('ONLINE');
    expect(res.json().supportedMethods).toBe('CARD,WALLET');
    expect(res.json().isActive).toBe(true);
    expect(res.json().totalVolume).toBe('0');
  });

  it('lists channel configs', async () => {
    await ctx.prisma.paymentChannelConfig.create({
      data: { userId: ctx.user.id, channelName: 'POS', channelType: 'IN_STORE', supportedMethods: 'CARD,CASH', currency: 'EUR', feePercent: 1.5 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-channel-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records a transaction', async () => {
    const c = await ctx.prisma.paymentChannelConfig.create({
      data: { userId: ctx.user.id, channelName: 'API', channelType: 'DIRECT', supportedMethods: 'BANK', currency: 'USD', feePercent: 0.5, isActive: true, transactionCount: 0, totalVolume: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-channel-configs/${c.id}/record`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '150000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionCount).toBe(1);
    expect(res.json().totalVolume).toBe('150000');
  });

  it('toggles a channel off', async () => {
    const c = await ctx.prisma.paymentChannelConfig.create({
      data: { userId: ctx.user.id, channelName: 'Mobile', channelType: 'APP', supportedMethods: 'WALLET', currency: 'GBP', feePercent: 1.0, isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-channel-configs/${c.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a channel config', async () => {
    const c = await ctx.prisma.paymentChannelConfig.create({
      data: { userId: ctx.user.id, channelName: 'Old', channelType: 'LEGACY', supportedMethods: 'CASH', currency: 'USD', feePercent: 0 },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-channel-configs/${c.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data channel analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-channel-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalChannels).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('merchant contracts', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a contract', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-contracts/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { merchantId: 'merch-1', contractType: 'standard', startDate: '2026-01-01', endDate: '2027-01-01', terms: 'Standard terms apply', monthlyFee: '50000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contractType).toBe('STANDARD');
    expect(res.json().status).toBe('DRAFT');
    expect(res.json().monthlyFee).toBe('50000');
  });

  it('lists contracts', async () => {
    await ctx.prisma.merchantContract.create({
      data: { userId: ctx.user.id, merchantId: 'm-1', contractType: 'PREMIUM', startDate: new Date(), endDate: new Date(), terms: 'Premium', monthlyFee: BigInt(100000) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-contracts/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('activates a contract', async () => {
    const c = await ctx.prisma.merchantContract.create({
      data: { userId: ctx.user.id, merchantId: 'm-2', contractType: 'BASIC', startDate: new Date(), endDate: new Date(), terms: 'Basic', monthlyFee: BigInt(25000), status: 'DRAFT' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-contracts/${c.id}/activate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('bills a cycle', async () => {
    const c = await ctx.prisma.merchantContract.create({
      data: { userId: ctx.user.id, merchantId: 'm-3', contractType: 'STANDARD', startDate: new Date(), endDate: new Date(), terms: 'Terms', monthlyFee: BigInt(50000), status: 'ACTIVE', billingCycles: 0, totalBilled: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-contracts/${c.id}/bill`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().billingCycles).toBe(1);
    expect(res.json().totalBilled).toBe('50000');
  });

  it('terminates a contract', async () => {
    const c = await ctx.prisma.merchantContract.create({
      data: { userId: ctx.user.id, merchantId: 'm-4', contractType: 'PREMIUM', startDate: new Date(), endDate: new Date(), terms: 'Terms', monthlyFee: BigInt(75000), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-contracts/${c.id}/terminate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Breach of contract' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('TERMINATED');
    expect(res.json().terminationReason).toBe('Breach of contract');
  });

  it('renews a contract', async () => {
    const c = await ctx.prisma.merchantContract.create({
      data: { userId: ctx.user.id, merchantId: 'm-5', contractType: 'STANDARD', startDate: new Date(), endDate: new Date('2027-01-01'), terms: 'Terms', monthlyFee: BigInt(40000), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-contracts/${c.id}/renew`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { newEndDate: '2028-01-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('returns no_data contract analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-contracts/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalContracts).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
