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
    payload: { email: 'b110@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b110@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('webhook event logs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a log entry', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/webhook-event-logs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { webhookConfigId: 'wh-1', eventType: 'payment.completed', payload: '{"id":"pay_123"}', targetUrl: 'https://example.com/hook' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().eventType).toBe('PAYMENT.COMPLETED');
    expect(res.json().status).toBe('PENDING');
  });

  it('lists log entries', async () => {
    await ctx.prisma.webhookEventLog.create({
      data: { userId: ctx.user.id, webhookConfigId: 'wh-2', eventType: 'INVOICE.PAID', payload: '{}', targetUrl: 'https://example.com/hook' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/webhook-event-logs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records a successful attempt', async () => {
    const l = await ctx.prisma.webhookEventLog.create({
      data: { userId: ctx.user.id, webhookConfigId: 'wh-3', eventType: 'TRANSFER.SENT', payload: '{}', targetUrl: 'https://example.com/hook', status: 'PENDING', attempts: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/webhook-event-logs/${l.id}/attempt`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { responseCode: 200, responseBody: 'OK' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DELIVERED');
    expect(res.json().attempts).toBe(1);
  });

  it('records a failed attempt', async () => {
    const l = await ctx.prisma.webhookEventLog.create({
      data: { userId: ctx.user.id, webhookConfigId: 'wh-4', eventType: 'REFUND.CREATED', payload: '{}', targetUrl: 'https://example.com/hook', status: 'PENDING', attempts: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/webhook-event-logs/${l.id}/attempt`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { responseCode: 500, responseBody: 'Internal Server Error' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FAILED');
  });

  it('retries a failed log', async () => {
    const l = await ctx.prisma.webhookEventLog.create({
      data: { userId: ctx.user.id, webhookConfigId: 'wh-5', eventType: 'DISPUTE.OPENED', payload: '{}', targetUrl: 'https://example.com/hook', status: 'FAILED', attempts: 1 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/webhook-event-logs/${l.id}/retry`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PENDING');
  });

  it('returns no_data log analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/webhook-event-logs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLogs).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment method tokens', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a token', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-method-tokens/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { methodType: 'visa', lastFour: '4242', expiryMonth: 12, expiryYear: 2027, billingCountry: 'us' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().methodType).toBe('VISA');
    expect(res.json().billingCountry).toBe('US');
    expect(res.json().token).toBeDefined();
    expect(res.json().isActive).toBe(true);
  });

  it('lists tokens', async () => {
    await ctx.prisma.paymentMethodToken.create({
      data: { userId: ctx.user.id, methodType: 'MASTERCARD', lastFour: '5678', expiryMonth: 6, expiryYear: 2026, billingCountry: 'GB', tokenHash: 'h1', tokenPrefix: 'tok_abc' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-method-tokens/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('uses a token', async () => {
    const t = await ctx.prisma.paymentMethodToken.create({
      data: { userId: ctx.user.id, methodType: 'VISA', lastFour: '1234', expiryMonth: 3, expiryYear: 2028, billingCountry: 'US', tokenHash: 'h2', tokenPrefix: 'tok_def', isActive: true, usageCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-method-tokens/${t.id}/use`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().usageCount).toBe(1);
  });

  it('deactivates a token', async () => {
    const t = await ctx.prisma.paymentMethodToken.create({
      data: { userId: ctx.user.id, methodType: 'AMEX', lastFour: '9999', expiryMonth: 9, expiryYear: 2027, billingCountry: 'DE', tokenHash: 'h3', tokenPrefix: 'tok_ghi', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-method-tokens/${t.id}/deactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a token', async () => {
    const t = await ctx.prisma.paymentMethodToken.create({
      data: { userId: ctx.user.id, methodType: 'DISCOVER', lastFour: '0000', expiryMonth: 1, expiryYear: 2026, billingCountry: 'CA', tokenHash: 'h4', tokenPrefix: 'tok_jkl' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-method-tokens/${t.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data token analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-method-tokens/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTokens).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('merchant payout configs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a config', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-payout-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { merchantId: 'merch-1', frequency: 'weekly', minimumPayout: '50000', currency: 'usd', bankAccountId: 'ba-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().frequency).toBe('WEEKLY');
    expect(res.json().currency).toBe('USD');
    expect(res.json().minimumPayout).toBe('50000');
    expect(res.json().isActive).toBe(true);
  });

  it('lists configs', async () => {
    await ctx.prisma.merchantPayoutConfig.create({
      data: { userId: ctx.user.id, merchantId: 'm-1', frequency: 'DAILY', minimumPayout: BigInt(10000), currency: 'EUR', bankAccountId: 'ba-2' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-payout-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records a payout', async () => {
    const c = await ctx.prisma.merchantPayoutConfig.create({
      data: { userId: ctx.user.id, merchantId: 'm-2', frequency: 'MONTHLY', minimumPayout: BigInt(100000), currency: 'USD', bankAccountId: 'ba-3', isActive: true, totalPayouts: 0, totalPaidOut: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-payout-configs/${c.id}/record`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '250000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPayouts).toBe(1);
    expect(res.json().totalPaidOut).toBe('250000');
  });

  it('toggles a config off', async () => {
    const c = await ctx.prisma.merchantPayoutConfig.create({
      data: { userId: ctx.user.id, merchantId: 'm-3', frequency: 'WEEKLY', minimumPayout: BigInt(50000), currency: 'GBP', bankAccountId: 'ba-4', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-payout-configs/${c.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a config', async () => {
    const c = await ctx.prisma.merchantPayoutConfig.create({
      data: { userId: ctx.user.id, merchantId: 'm-4', frequency: 'BIWEEKLY', minimumPayout: BigInt(25000), currency: 'CAD', bankAccountId: 'ba-5' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/merchant-payout-configs/${c.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data config analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-payout-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConfigs).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
