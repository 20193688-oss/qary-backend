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
    payload: { email: 'b109@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b109@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('currency exchange rates', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a rate', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/currency-exchange-rates/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { baseCurrency: 'usd', targetCurrency: 'eur', rate: 0.92, marginPercent: 1.5, source: 'reuters' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().baseCurrency).toBe('USD');
    expect(res.json().targetCurrency).toBe('EUR');
    expect(res.json().source).toBe('REUTERS');
    expect(res.json().isActive).toBe(true);
  });

  it('lists rates', async () => {
    await ctx.prisma.currencyExchangeRate.create({
      data: { userId: ctx.user.id, baseCurrency: 'GBP', targetCurrency: 'USD', rate: 1.27, marginPercent: 1, effectiveRate: 1.2827, source: 'ECB' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/currency-exchange-rates/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('updates a rate', async () => {
    const r = await ctx.prisma.currencyExchangeRate.create({
      data: { userId: ctx.user.id, baseCurrency: 'USD', targetCurrency: 'JPY', rate: 150.5, marginPercent: 2, effectiveRate: 153.51, source: 'MANUAL' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/currency-exchange-rates/${r.id}/update`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { rate: 148.0, marginPercent: 1.0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rate).toBe(148.0);
    expect(res.json().effectiveRate).toBeCloseTo(149.48);
  });

  it('records usage', async () => {
    const r = await ctx.prisma.currencyExchangeRate.create({
      data: { userId: ctx.user.id, baseCurrency: 'EUR', targetCurrency: 'GBP', rate: 0.86, marginPercent: 1, effectiveRate: 0.8686, source: 'API', isActive: true, usageCount: 0, totalVolumeConverted: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/currency-exchange-rates/${r.id}/record`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { volume: '500000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().usageCount).toBe(1);
    expect(res.json().totalVolumeConverted).toBe('500000');
  });

  it('toggles a rate off', async () => {
    const r = await ctx.prisma.currencyExchangeRate.create({
      data: { userId: ctx.user.id, baseCurrency: 'USD', targetCurrency: 'CHF', rate: 0.88, marginPercent: 0.5, effectiveRate: 0.8844, source: 'FEED', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/currency-exchange-rates/${r.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a rate', async () => {
    const r = await ctx.prisma.currencyExchangeRate.create({
      data: { userId: ctx.user.id, baseCurrency: 'AUD', targetCurrency: 'NZD', rate: 1.08, marginPercent: 1, effectiveRate: 1.0908, source: 'MANUAL' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/currency-exchange-rates/${r.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data rate analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/currency-exchange-rates/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRates).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment retry policies', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a policy', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-retry-policies/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Standard Retry', maxRetries: 3, retryIntervalMinutes: 60, backoffMultiplier: 2, applicableMethods: 'card,bank' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Standard Retry');
    expect(res.json().applicableMethods).toBe('CARD,BANK');
    expect(res.json().isActive).toBe(true);
  });

  it('lists policies', async () => {
    await ctx.prisma.paymentRetryPolicy.create({
      data: { userId: ctx.user.id, name: 'Aggressive', maxRetries: 5, retryIntervalMinutes: 15, backoffMultiplier: 1.5, applicableMethods: 'WALLET' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-retry-policies/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records a successful retry', async () => {
    const p = await ctx.prisma.paymentRetryPolicy.create({
      data: { userId: ctx.user.id, name: 'Retry Log', maxRetries: 3, retryIntervalMinutes: 30, backoffMultiplier: 2, applicableMethods: 'CARD', isActive: true, totalRetries: 0, successfulRetries: 0, failedRetries: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-retry-policies/${p.id}/record`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { success: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRetries).toBe(1);
    expect(res.json().successfulRetries).toBe(1);
    expect(res.json().failedRetries).toBe(0);
  });

  it('records a failed retry', async () => {
    const p = await ctx.prisma.paymentRetryPolicy.create({
      data: { userId: ctx.user.id, name: 'Fail Track', maxRetries: 3, retryIntervalMinutes: 30, backoffMultiplier: 2, applicableMethods: 'BANK', isActive: true, totalRetries: 0, successfulRetries: 0, failedRetries: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-retry-policies/${p.id}/record`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { success: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRetries).toBe(1);
    expect(res.json().failedRetries).toBe(1);
  });

  it('toggles a policy off', async () => {
    const p = await ctx.prisma.paymentRetryPolicy.create({
      data: { userId: ctx.user.id, name: 'Toggle Me', maxRetries: 2, retryIntervalMinutes: 120, backoffMultiplier: 1, applicableMethods: 'ALL', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-retry-policies/${p.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a policy', async () => {
    const p = await ctx.prisma.paymentRetryPolicy.create({
      data: { userId: ctx.user.id, name: 'Remove', maxRetries: 1, retryIntervalMinutes: 10, backoffMultiplier: 1, applicableMethods: 'CARD' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-retry-policies/${p.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data policy analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-retry-policies/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPolicies).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('merchant api credentials', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a credential', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-api-credentials/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { merchantId: 'merch-1', label: 'Production Key', environment: 'production', permissions: 'read,write' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().environment).toBe('PRODUCTION');
    expect(res.json().permissions).toBe('READ,WRITE');
    expect(res.json().apiKey).toBeDefined();
    expect(res.json().apiSecret).toBeDefined();
    expect(res.json().isActive).toBe(true);
  });

  it('lists credentials', async () => {
    await ctx.prisma.merchantApiCredential.create({
      data: { userId: ctx.user.id, merchantId: 'm-1', label: 'Test', environment: 'SANDBOX', permissions: 'READ', apiKeyPrefix: 'mk_abc123', apiKeyHash: 'hash1', secretHash: 'hash2' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-api-credentials/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records usage', async () => {
    const c = await ctx.prisma.merchantApiCredential.create({
      data: { userId: ctx.user.id, merchantId: 'm-2', label: 'Usage Test', environment: 'PRODUCTION', permissions: 'ALL', apiKeyPrefix: 'mk_def456', apiKeyHash: 'h1', secretHash: 'h2', isActive: true, usageCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-api-credentials/${c.id}/record-usage`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().usageCount).toBe(1);
  });

  it('revokes a credential', async () => {
    const c = await ctx.prisma.merchantApiCredential.create({
      data: { userId: ctx.user.id, merchantId: 'm-3', label: 'Revoke Me', environment: 'PRODUCTION', permissions: 'READ', apiKeyPrefix: 'mk_ghi789', apiKeyHash: 'h3', secretHash: 'h4', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-api-credentials/${c.id}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a credential', async () => {
    const c = await ctx.prisma.merchantApiCredential.create({
      data: { userId: ctx.user.id, merchantId: 'm-4', label: 'Delete Me', environment: 'TEST', permissions: 'READ', apiKeyPrefix: 'mk_jkl012', apiKeyHash: 'h5', secretHash: 'h6' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/merchant-api-credentials/${c.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data credential analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-api-credentials/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCredentials).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
