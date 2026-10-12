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
    payload: { email: 'b22@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b22@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('transaction search', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('searches transactions by description', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', amount: 1000 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/search?q=deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('returns empty for unmatched query', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-history/search?q=nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('invoice summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns aggregate invoice summary', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'FACTURA', currency: 'USD', subtotal: 100, country: 'PE', senderName: 'Test' },
    });
    const inv2 = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'BOLETA', currency: 'USD', subtotal: 200, country: 'PE', senderName: 'Test' },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${inv2.json().id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalInvoices).toBe(2);
    expect(Number(res.json().totalBilled)).toBeGreaterThan(0);
    expect(Number(res.json().totalCollected)).toBeGreaterThan(0);
    expect(res.json().byStatus.PAID).toBe(1);
    expect(res.json().byStatus.ISSUED).toBe(1);
  });

  it('returns zeros when no invoices exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalInvoices).toBe(0);
    expect(res.json().totalBilled).toBe('0');
  });
});

describe('dispute stats', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns dispute statistics', async () => {
    const gp = await ctx.prisma.gatewayPayment.create({
      data: {
        userId: ctx.user.id, gateway: 'stripe', gatewayId: 'pi_test1',
        status: 'COMPLETED', amount: BigInt(5000), currency: 'USD',
      },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayPaymentId: gp.id, reason: 'fraud', amount: 50, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalDisputes).toBe(1);
    expect(res.json().byStatus.OPENED).toBe(1);
    expect(Number(res.json().totalAmount)).toBeGreaterThan(0);
  });

  it('returns zeros when no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalDisputes).toBe(0);
    expect(res.json().totalAmount).toBe('0');
  });
});

describe('card stats', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns card statistics by network', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_1', last4: '1234', network: 'VISA', expiryMonth: 12, expiryYear: 2028 },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { vaultToken: 'tok_2', last4: '5678', network: 'MASTERCARD', expiryMonth: 6, expiryYear: 2027 },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCards).toBe(2);
    expect(res.json().active).toBe(2);
    expect(res.json().frozen).toBe(0);
    expect(res.json().byNetwork.VISA).toBe(1);
    expect(res.json().byNetwork.MASTERCARD).toBe(1);
  });

  it('returns zeros when no cards', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/stats',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCards).toBe(0);
  });
});

describe('payment link analytics', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns link analytics', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 25, currency: 'USD', description: 'Test link' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/payment-links',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLinks).toBe(2);
    expect(res.json().totalCollected).toBe('0');
    expect(res.json().byStatus.active).toBe(2);
  });

  it('returns zeros when no links', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-links/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalLinks).toBe(0);
  });
});
