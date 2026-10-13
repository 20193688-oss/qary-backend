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
    payload: { email: 'b48@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b48@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('events anomaly detection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns low risk with only bootstrap events', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/anomaly-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEvents).toBeGreaterThan(0);
    expect(body.anomalies).toBeInstanceOf(Array);
    expect(body.rareEventTypes).toBeInstanceOf(Array);
  });

  it('detects rare event types', async () => {
    await ctx.prisma.event.create({
      data: {
        userId: ctx.user.id, actor: 'user', eventType: 'custom.rare_action',
        payload: {}, severity: 'INFO',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/events/anomaly-detection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rareEventTypes).toContain('custom.rare_action');
    expect(body.anomalies.some((a: any) => a.type === 'rare_event')).toBe(true);
  });
});

describe('fx currency exposure report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns neutral with no conversions', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/currency-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(0);
    expect(body.netFlows).toEqual({});
    expect(body.primarySourceCurrency).toBeNull();
    expect(body.primaryTargetCurrency).toBeNull();
    expect(body.directionalBias).toBe('neutral');
  });

  it('computes net flows from conversions', async () => {
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'FX_CONVERSION', status: 'COMPLETED',
        amount: BigInt(10000), currency: 'USD',
        fxSourceCurrency: 'USD', fxTargetCurrency: 'EUR',
        fxSourceAmount: BigInt(10000), fxTargetAmount: BigInt(9200),
      },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'FX_CONVERSION', status: 'COMPLETED',
        amount: BigInt(5000), currency: 'USD',
        fxSourceCurrency: 'USD', fxTargetCurrency: 'PEN',
        fxSourceAmount: BigInt(5000), fxTargetAmount: BigInt(18750),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fx/currency-exposure',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalConversions).toBe(2);
    expect(body.primarySourceCurrency).toBe('USD');
    expect(body.netFlows.USD).toBe('-15000');
    expect(body.netFlows.EUR).toBe('9200');
    expect(body.netFlows.PEN).toBe('18750');
    expect(body.directionalBias).toContain('USD');
  });
});

describe('gateway revenue analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zeros with no payments', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/revenue-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(0);
    expect(body.totalProcessed).toBe('0');
    expect(body.totalFees).toBe('0');
    expect(body.netRevenue).toBe('0');
    expect(body.byMethod).toEqual({});
  });

  it('analyzes revenue across payments', async () => {
    const tx1 = await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED', amount: BigInt(50000), currency: 'USD' },
    });
    const tx2 = await ctx.prisma.transaction.create({
      data: { userId: ctx.user.id, type: 'PAYMENT', status: 'COMPLETED', amount: BigInt(30000), currency: 'USD' },
    });

    await ctx.prisma.gatewayPayment.create({
      data: {
        userId: ctx.user.id, transactionId: tx1.id,
        paymentMethod: 'CARD', amount: BigInt(50000), currency: 'USD',
        status: 'CAPTURED', gatewayFee: BigInt(1500),
      },
    });
    await ctx.prisma.gatewayPayment.create({
      data: {
        userId: ctx.user.id, transactionId: tx2.id,
        paymentMethod: 'BANK_TRANSFER', amount: BigInt(30000), currency: 'USD',
        status: 'REFUNDED', gatewayFee: BigInt(500),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/gateway/revenue-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPayments).toBe(2);
    expect(body.totalProcessed).toBe('80000');
    expect(body.totalFees).toBe('2000');
    expect(body.refundedAmount).toBe('30000');
    expect(body.netRevenue).toBe('48000');
    expect(body.byMethod.CARD.count).toBe(1);
    expect(body.byMethod.BANK_TRANSFER.count).toBe(1);
    expect(body.byStatus.CAPTURED).toBe(1);
    expect(body.byStatus.REFUNDED).toBe(1);
  });
});

describe('invoices cash flow projection', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty projection with no invoices', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/cash-flow-projection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(0);
    expect(body.unpaidCount).toBe(0);
    expect(body.paidCount).toBe(0);
    expect(body.upcomingTotal).toBe('0');
    expect(body.upcoming).toBeInstanceOf(Array);
    expect(body.upcoming.length).toBe(0);
  });

  it('projects cash flow from mixed invoices', async () => {
    const inv1 = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'BOLETA', currency: 'USD', subtotal: 100, country: 'US', receiverName: 'Client A' },
    });
    const inv2 = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'FACTURA', currency: 'USD', subtotal: 200, country: 'US', receiverName: 'Client B' },
    });

    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${inv1.json().id}/send`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${inv2.json().id}/send`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${inv1.json().id}/pay`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/cash-flow-projection',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalInvoices).toBe(2);
    expect(body.paidCount).toBe(1);
    expect(body.unpaidCount).toBe(1);
    expect(body.historicalCollectionRate).toBe(50);
    expect(body.upcoming.length).toBe(1);
    expect(body.upcoming[0].receiverName).toBe('Client B');
  });
});

describe('kyc document completeness', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no kyc profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/document-completeness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('kyc_not_found');
  });

  it('reports completeness after partial setup', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'DNI', documentNumber: '12345678', documentCountry: 'PE',
        firstName: 'Test', lastName: 'User',
      },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/documents',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { documentFrontUrl: 'https://example.com/front.jpg', selfieUrl: 'https://example.com/selfie.jpg' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/document-completeness',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploadedDocuments).toBe(2);
    expect(body.totalDocuments).toBe(4);
    expect(body.documentCompleteness).toBe(50);
    expect(body.missingDocuments).toContain('Document Back');
    expect(body.missingDocuments).toContain('Liveness Image');
    expect(body.personalCompleteness).toBeGreaterThan(0);
    expect(body.isReady).toBe(false);
    expect(body.status).toBeDefined();
  });
});
