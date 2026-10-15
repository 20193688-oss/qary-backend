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
    payload: { email: 'sp2@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'sp2@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('transaction map - geo tracking', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('records a transaction location', async () => {
    const w = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000) },
    });
    const txn = await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, walletId: w.id, type: 'payment', amount: BigInt(5000), currency: 'USD', status: 'completed', reference: 'TXN-MAP1' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-map/record',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionId: txn.id, latitude: 4.6097, longitude: -74.0817, city: 'Bogota', country: 'CO' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().city).toBe('Bogota');
    expect(res.json().country).toBe('CO');
  });

  it('lists transaction locations', async () => {
    await ctx.prisma.transactionLocation.create({
      data: { userId: ctx.user.id, transactionId: 'txn1', latitude: 4.61, longitude: -74.08, city: 'Bogota', country: 'CO' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-map/locations',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('returns no_data geo analytics without locations', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-map/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLocations).toBe(0);
    expect(body.geoLevel).toBe('no_data');
  });

  it('returns geo analytics with locations', async () => {
    await ctx.prisma.transactionLocation.create({
      data: { userId: ctx.user.id, transactionId: 'txn1', latitude: 4.61, longitude: -74.08, city: 'Bogota', country: 'CO' },
    });
    await ctx.prisma.transactionLocation.create({
      data: { userId: ctx.user.id, transactionId: 'txn2', latitude: 40.42, longitude: -3.70, city: 'Madrid', country: 'ES' },
    });
    await ctx.prisma.transactionLocation.create({
      data: { userId: ctx.user.id, transactionId: 'txn3', latitude: 4.62, longitude: -74.07, city: 'Bogota', country: 'CO' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-map/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLocations).toBe(3);
    expect(body.countries.length).toBe(2);
    expect(body.geoLevel).toBe('multi_country');
    expect(body.heatmapClusters.length).toBeGreaterThanOrEqual(1);
  });
});

describe('safe-pay - payment confirmation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payment confirmation', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/safe-pay/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50000, currency: 'USD', merchantName: 'TechShop', channel: 'POS' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('PENDING');
    expect(body.confirmationCode).toBeDefined();
    expect(body.amount).toBe('50000');
    expect(body.merchantName).toBe('TechShop');
  });

  it('confirms a payment with correct code', async () => {
    const confirmation = await ctx.prisma.safePayConfirmation.create({
      data: {
        userId: ctx.user.id, amount: BigInt(50000), currency: 'USD',
        merchantName: 'TechShop', channel: 'POS', confirmationCode: '123456',
        status: 'PENDING', expiresAt: new Date(Date.now() + 1200000),
      },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/safe-pay/${confirmation.id}/confirm`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { confirmationCode: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CONFIRMED');
  });

  it('rejects invalid confirmation code', async () => {
    const confirmation = await ctx.prisma.safePayConfirmation.create({
      data: {
        userId: ctx.user.id, amount: BigInt(50000), currency: 'USD',
        merchantName: 'TechShop', channel: 'POS', confirmationCode: '123456',
        status: 'PENDING', expiresAt: new Date(Date.now() + 1200000),
      },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/safe-pay/${confirmation.id}/confirm`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { confirmationCode: '999999' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_confirmation_code');
  });

  it('cancels a pending confirmation', async () => {
    const confirmation = await ctx.prisma.safePayConfirmation.create({
      data: {
        userId: ctx.user.id, amount: BigInt(50000), currency: 'USD',
        merchantName: 'TechShop', channel: 'POS', confirmationCode: '123456',
        status: 'PENDING', expiresAt: new Date(Date.now() + 1200000),
      },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/safe-pay/${confirmation.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('lists pending confirmations', async () => {
    await ctx.prisma.safePayConfirmation.create({
      data: {
        userId: ctx.user.id, amount: BigInt(50000), currency: 'USD',
        merchantName: 'A', channel: 'POS', confirmationCode: '111111',
        status: 'PENDING', expiresAt: new Date(Date.now() + 1200000),
      },
    });
    await ctx.prisma.safePayConfirmation.create({
      data: {
        userId: ctx.user.id, amount: BigInt(30000), currency: 'USD',
        merchantName: 'B', channel: 'POS', confirmationCode: '222222',
        status: 'CONFIRMED', expiresAt: new Date(Date.now() + 1200000),
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/safe-pay/pending',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('returns no_data metrics with no confirmations', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/safe-pay/metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConfirmations).toBe(0);
    expect(body.metricsLevel).toBe('no_data');
  });

  it('returns metrics with confirmations', async () => {
    await ctx.prisma.safePayConfirmation.create({
      data: {
        userId: ctx.user.id, amount: BigInt(50000), currency: 'USD',
        merchantName: 'A', channel: 'POS', confirmationCode: '111111',
        status: 'CONFIRMED', expiresAt: new Date(Date.now() + 1200000),
        confirmedAt: new Date(),
      },
    });
    await ctx.prisma.safePayConfirmation.create({
      data: {
        userId: ctx.user.id, amount: BigInt(30000), currency: 'USD',
        merchantName: 'B', channel: 'POS', confirmationCode: '222222',
        status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000),
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/safe-pay/metrics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConfirmations).toBe(2);
    expect(body.breakdown.confirmed).toBe(1);
    expect(body.metricsLevel).toBeDefined();
  });
});
