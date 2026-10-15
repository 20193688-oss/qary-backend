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
    payload: { email: 'b112@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b112@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('compliance documents', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a document', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/compliance-documents/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { documentType: 'policy', title: 'AML Policy', description: 'Anti-money laundering policy', jurisdiction: 'us', effectiveDate: '2026-01-01' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().documentType).toBe('POLICY');
    expect(res.json().jurisdiction).toBe('US');
    expect(res.json().status).toBe('DRAFT');
  });

  it('lists documents', async () => {
    await ctx.prisma.complianceDocument.create({
      data: { userId: ctx.user.id, documentType: 'PROCEDURE', title: 'KYC Procedure', description: 'Steps', jurisdiction: 'EU', effectiveDate: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-documents/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('submits for review', async () => {
    const d = await ctx.prisma.complianceDocument.create({
      data: { userId: ctx.user.id, documentType: 'REPORT', title: 'SAR', description: 'Suspicious activity', jurisdiction: 'US', effectiveDate: new Date(), status: 'DRAFT', reviewCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-documents/${d.id}/submit`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('IN_REVIEW');
    expect(res.json().reviewCount).toBe(1);
  });

  it('approves a document', async () => {
    const d = await ctx.prisma.complianceDocument.create({
      data: { userId: ctx.user.id, documentType: 'POLICY', title: 'Approve Me', description: 'Test', jurisdiction: 'UK', effectiveDate: new Date(), status: 'IN_REVIEW' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-documents/${d.id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { approvedBy: 'compliance-officer-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
    expect(res.json().approvedBy).toBe('compliance-officer-1');
  });

  it('archives a document', async () => {
    const d = await ctx.prisma.complianceDocument.create({
      data: { userId: ctx.user.id, documentType: 'STANDARD', title: 'Archive', description: 'Old', jurisdiction: 'SG', effectiveDate: new Date(), status: 'APPROVED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-documents/${d.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARCHIVED');
  });

  it('returns no_data document analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-documents/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalDocuments).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment routing rules', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a rule', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-routing-rules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'High Value Stripe', condition: 'amount_above', targetGateway: 'Stripe', priority: 1, currency: 'usd', minAmount: '100000', maxAmount: '10000000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().condition).toBe('AMOUNT_ABOVE');
    expect(res.json().currency).toBe('USD');
    expect(res.json().isActive).toBe(true);
    expect(res.json().minAmount).toBe('100000');
  });

  it('lists rules', async () => {
    await ctx.prisma.paymentRoutingRule.create({
      data: { userId: ctx.user.id, name: 'EU PayPal', condition: 'REGION', targetGateway: 'PayPal', priority: 2, currency: 'EUR', minAmount: BigInt(0), maxAmount: BigInt(500000) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-routing-rules/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records a match', async () => {
    const r = await ctx.prisma.paymentRoutingRule.create({
      data: { userId: ctx.user.id, name: 'Match Me', condition: 'CURRENCY', targetGateway: 'Adyen', priority: 1, currency: 'GBP', minAmount: BigInt(0), maxAmount: BigInt(999999), isActive: true, matchCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-routing-rules/${r.id}/match`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matchCount).toBe(1);
  });

  it('toggles a rule off', async () => {
    const r = await ctx.prisma.paymentRoutingRule.create({
      data: { userId: ctx.user.id, name: 'Disable', condition: 'METHOD', targetGateway: 'Square', priority: 3, currency: 'USD', minAmount: BigInt(0), maxAmount: BigInt(100000), isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-routing-rules/${r.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a rule', async () => {
    const r = await ctx.prisma.paymentRoutingRule.create({
      data: { userId: ctx.user.id, name: 'Remove', condition: 'DEFAULT', targetGateway: 'Stripe', priority: 99, currency: 'USD', minAmount: BigInt(0), maxAmount: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-routing-rules/${r.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data routing analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-routing-rules/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRules).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('merchant discount programs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a program', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-discount-programs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Summer Sale', discountType: 'percentage', discountValue: 15, merchantId: 'merch-1', startDate: '2026-06-01', endDate: '2026-08-31', maxRedemptions: 1000 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().discountType).toBe('PERCENTAGE');
    expect(res.json().isActive).toBe(true);
    expect(res.json().totalSavings).toBe('0');
  });

  it('lists programs', async () => {
    await ctx.prisma.merchantDiscountProgram.create({
      data: { userId: ctx.user.id, name: 'Flash', discountType: 'FLAT', discountValue: 500, merchantId: 'm-1', startDate: new Date(), endDate: new Date(), maxRedemptions: 100 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-discount-programs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('redeems a discount', async () => {
    const p = await ctx.prisma.merchantDiscountProgram.create({
      data: { userId: ctx.user.id, name: 'Redeem Me', discountType: 'PERCENTAGE', discountValue: 10, merchantId: 'm-2', startDate: new Date(), endDate: new Date(), maxRedemptions: 500, isActive: true, currentRedemptions: 0, totalSavings: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-discount-programs/${p.id}/redeem`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { savedAmount: '2500' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentRedemptions).toBe(1);
    expect(res.json().totalSavings).toBe('2500');
  });

  it('toggles a program off', async () => {
    const p = await ctx.prisma.merchantDiscountProgram.create({
      data: { userId: ctx.user.id, name: 'Toggle', discountType: 'FLAT', discountValue: 100, merchantId: 'm-3', startDate: new Date(), endDate: new Date(), maxRedemptions: 50, isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-discount-programs/${p.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a program', async () => {
    const p = await ctx.prisma.merchantDiscountProgram.create({
      data: { userId: ctx.user.id, name: 'Delete', discountType: 'PERCENTAGE', discountValue: 5, merchantId: 'm-4', startDate: new Date(), endDate: new Date(), maxRedemptions: 10 },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/merchant-discount-programs/${p.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data program analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-discount-programs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPrograms).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
