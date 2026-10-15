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
    payload: { email: 'sp1@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'sp1@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('credit express - apply and manage', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('applies for a credit line', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/credit-express/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', requestedAmount: 500000, termMonths: 12, purpose: 'Working capital' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.currency).toBe('USD');
    expect(body.creditLimit).toBe('500000');
    expect(body.status).toBe('PENDING_APPROVAL');
  });

  it('prevents duplicate active credit line', async () => {
    await ctx.prisma.creditLine.create({
      data: { userId: ctx.user.id, currency: 'USD', creditLimit: BigInt(500000), availableCredit: BigInt(500000), usedCredit: BigInt(0), termMonths: 12, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/credit-express/apply',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', requestedAmount: 300000, termMonths: 6, purpose: 'Expansion' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('active_credit_line_exists');
  });

  it('lists credit lines', async () => {
    await ctx.prisma.creditLine.create({
      data: { userId: ctx.user.id, currency: 'USD', creditLimit: BigInt(500000), availableCredit: BigInt(500000), usedCredit: BigInt(0), termMonths: 12, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/credit-express/lines',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(1);
    expect(body[0].creditLimit).toBe('500000');
  });

  it('gets credit summary', async () => {
    await ctx.prisma.creditLine.create({
      data: { userId: ctx.user.id, currency: 'USD', creditLimit: BigInt(500000), availableCredit: BigInt(400000), usedCredit: BigInt(100000), termMonths: 12, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/credit-express/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalLines).toBe(1);
    expect(body.activeLines).toBe(1);
    expect(body.totalLimit).toBe('500000');
    expect(body.utilizationRate).toBe(20);
    expect(body.healthLevel).toBe('excellent');
  });

  it('returns no_data summary with no lines', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/credit-express/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().healthLevel).toBe('no_data');
  });

  it('disburses from active credit line', async () => {
    const line = await ctx.prisma.creditLine.create({
      data: { userId: ctx.user.id, currency: 'USD', creditLimit: BigInt(500000), availableCredit: BigInt(500000), usedCredit: BigInt(0), termMonths: 12, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/credit-express/${line.id}/disburse`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100000 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe('100000');
    expect(res.json().status).toBe('COMPLETED');
  });

  it('repays credit', async () => {
    const line = await ctx.prisma.creditLine.create({
      data: { userId: ctx.user.id, currency: 'USD', creditLimit: BigInt(500000), availableCredit: BigInt(400000), usedCredit: BigInt(100000), termMonths: 12, status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/credit-express/${line.id}/repay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 50000 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe('50000');
  });
});

describe('cross-border transfers', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('gets an exchange quote', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/cross-border/quote',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { sourceCurrency: 'USD', targetCurrency: 'EUR', amount: 100000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sourceCurrency).toBe('USD');
    expect(body.targetCurrency).toBe('EUR');
    expect(body.fxRate).toBe(0.92);
    expect(body.fee).toBeDefined();
    expect(body.validUntil).toBeDefined();
  });

  it('initiates a cross-border transfer', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/cross-border/transfer',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        sourceCurrency: 'USD', targetCurrency: 'EUR', amount: 100000,
        recipientName: 'Juan Perez', recipientCountry: 'ES',
        recipientBankCode: 'BBVAESMMXXX', recipientAccountNumber: 'ES1234567890',
        purpose: 'Family support',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('PROCESSING');
    expect(body.sourceCurrency).toBe('USD');
    expect(body.targetCurrency).toBe('EUR');
    expect(body.sourceAmount).toBeDefined();
  });

  it('lists transfers', async () => {
    await ctx.prisma.crossBorderTransfer.create({
      data: {
        userId: ctx.user.id, sourceCurrency: 'USD', targetCurrency: 'EUR',
        sourceAmount: BigInt(100000), targetAmount: BigInt(92000), fxRate: 0.92,
        fee: BigInt(500), recipientName: 'Test', recipientCountry: 'ES',
        recipientBankCode: 'BBVA', recipientAccountNumber: 'ES123',
        purpose: 'Test', status: 'COMPLETED', reference: 'XBR-1',
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cross-border/transfers',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(1);
    expect(body[0].sourceAmount).toBe('100000');
  });

  it('cancels a processing transfer', async () => {
    const t = await ctx.prisma.crossBorderTransfer.create({
      data: {
        userId: ctx.user.id, sourceCurrency: 'USD', targetCurrency: 'EUR',
        sourceAmount: BigInt(100000), targetAmount: BigInt(92000), fxRate: 0.92,
        fee: BigInt(500), recipientName: 'Test', recipientCountry: 'ES',
        recipientBankCode: 'BBVA', recipientAccountNumber: 'ES123',
        purpose: 'Test', status: 'PROCESSING', reference: 'XBR-2',
      },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cross-border/${t.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns analytics with no_data', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cross-border/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(0);
    expect(body.analyticsLevel).toBe('no_data');
  });

  it('returns analytics with transfers', async () => {
    await ctx.prisma.crossBorderTransfer.create({
      data: {
        userId: ctx.user.id, sourceCurrency: 'USD', targetCurrency: 'EUR',
        sourceAmount: BigInt(100000), targetAmount: BigInt(92000), fxRate: 0.92,
        fee: BigInt(500), recipientName: 'A', recipientCountry: 'ES',
        recipientBankCode: 'BBVA', recipientAccountNumber: 'ES1',
        purpose: 'Test', status: 'COMPLETED', reference: 'XBR-A1',
      },
    });
    await ctx.prisma.crossBorderTransfer.create({
      data: {
        userId: ctx.user.id, sourceCurrency: 'USD', targetCurrency: 'GBP',
        sourceAmount: BigInt(200000), targetAmount: BigInt(158000), fxRate: 0.79,
        fee: BigInt(1000), recipientName: 'B', recipientCountry: 'GB',
        recipientBankCode: 'HSBC', recipientAccountNumber: 'GB1',
        purpose: 'Business', status: 'COMPLETED', reference: 'XBR-A2',
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cross-border/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTransfers).toBe(2);
    expect(body.corridors.length).toBe(2);
    expect(body.analyticsLevel).toBe('excellent');
  });
});
