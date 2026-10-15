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
    payload: { email: 'b108@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b108@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment reconciliations', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a reconciliation', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-reconciliations/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { periodStart: '2026-01-01', periodEnd: '2026-01-31', currency: 'usd', source: 'stripe' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().currency).toBe('USD');
    expect(res.json().source).toBe('STRIPE');
    expect(res.json().status).toBe('PENDING');
  });

  it('lists reconciliations', async () => {
    await ctx.prisma.paymentReconciliation.create({
      data: { userId: ctx.user.id, periodStart: new Date(), periodEnd: new Date(), currency: 'EUR', source: 'BANK' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-reconciliations/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('processes a reconciliation', async () => {
    const r = await ctx.prisma.paymentReconciliation.create({
      data: { userId: ctx.user.id, periodStart: new Date(), periodEnd: new Date(), currency: 'USD', source: 'STRIPE', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-reconciliations/${r.id}/process`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { matchedCount: 50, unmatchedCount: 3, totalExpected: '1000000', totalActual: '990000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PROCESSED');
    expect(res.json().matchedCount).toBe(50);
    expect(res.json().discrepancy).toBe('10000');
  });

  it('approves a processed reconciliation', async () => {
    const r = await ctx.prisma.paymentReconciliation.create({
      data: { userId: ctx.user.id, periodStart: new Date(), periodEnd: new Date(), currency: 'USD', source: 'STRIPE', status: 'PROCESSED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-reconciliations/${r.id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
  });

  it('rejects a processed reconciliation', async () => {
    const r = await ctx.prisma.paymentReconciliation.create({
      data: { userId: ctx.user.id, periodStart: new Date(), periodEnd: new Date(), currency: 'USD', source: 'STRIPE', status: 'PROCESSED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-reconciliations/${r.id}/reject`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Data mismatch found' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
    expect(res.json().rejectionReason).toBe('Data mismatch found');
  });

  it('returns no_data reconciliation analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-reconciliations/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalReconciliations).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('merchant fee overrides', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an override', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-fee-overrides/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { merchantId: 'merch-1', feeType: 'interchange', feePercent: 2.5, flatFee: '100', currency: 'usd', effectiveFrom: '2026-01-01' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().feeType).toBe('INTERCHANGE');
    expect(res.json().currency).toBe('USD');
    expect(res.json().isActive).toBe(true);
    expect(res.json().flatFee).toBe('100');
  });

  it('lists overrides', async () => {
    await ctx.prisma.merchantFeeOverride.create({
      data: { userId: ctx.user.id, merchantId: 'm-1', feeType: 'MARKUP', feePercent: 1.5, flatFee: BigInt(50), currency: 'EUR', effectiveFrom: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-fee-overrides/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('applies a fee', async () => {
    const o = await ctx.prisma.merchantFeeOverride.create({
      data: { userId: ctx.user.id, merchantId: 'm-2', feeType: 'PROCESSING', feePercent: 3.0, flatFee: BigInt(0), currency: 'USD', effectiveFrom: new Date(), isActive: true, appliedCount: 0, totalFeeCollected: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-fee-overrides/${o.id}/apply`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '5000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().appliedCount).toBe(1);
    expect(res.json().totalFeeCollected).toBe('5000');
  });

  it('toggles an override off', async () => {
    const o = await ctx.prisma.merchantFeeOverride.create({
      data: { userId: ctx.user.id, merchantId: 'm-3', feeType: 'DISCOUNT', feePercent: 0, flatFee: BigInt(200), currency: 'GBP', effectiveFrom: new Date(), isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-fee-overrides/${o.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes an override', async () => {
    const o = await ctx.prisma.merchantFeeOverride.create({
      data: { userId: ctx.user.id, merchantId: 'm-4', feeType: 'FLAT', feePercent: 0, flatFee: BigInt(100), currency: 'USD', effectiveFrom: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/merchant-fee-overrides/${o.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data override analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-fee-overrides/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalOverrides).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('transaction alert rules', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a rule', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-alert-rules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'High Value', condition: 'amount_above', threshold: '100000', currency: 'usd', channel: 'email' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().condition).toBe('AMOUNT_ABOVE');
    expect(res.json().channel).toBe('EMAIL');
    expect(res.json().isActive).toBe(true);
    expect(res.json().threshold).toBe('100000');
  });

  it('lists rules', async () => {
    await ctx.prisma.transactionAlertRule.create({
      data: { userId: ctx.user.id, name: 'Suspicious', condition: 'VELOCITY', threshold: BigInt(5), currency: 'USD', channel: 'SMS' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-alert-rules/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('triggers a rule', async () => {
    const r = await ctx.prisma.transactionAlertRule.create({
      data: { userId: ctx.user.id, name: 'Over Limit', condition: 'AMOUNT_ABOVE', threshold: BigInt(50000), currency: 'USD', channel: 'PUSH', isActive: true, triggerCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-alert-rules/${r.id}/trigger`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().triggerCount).toBe(1);
  });

  it('toggles a rule off', async () => {
    const r = await ctx.prisma.transactionAlertRule.create({
      data: { userId: ctx.user.id, name: 'Disable me', condition: 'AMOUNT_BELOW', threshold: BigInt(1000), currency: 'EUR', channel: 'EMAIL', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-alert-rules/${r.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a rule', async () => {
    const r = await ctx.prisma.transactionAlertRule.create({
      data: { userId: ctx.user.id, name: 'Remove', condition: 'FREQUENCY', threshold: BigInt(10), currency: 'GBP', channel: 'WEBHOOK' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/transaction-alert-rules/${r.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data rule analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-alert-rules/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRules).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
