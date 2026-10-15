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
    payload: { email: 'b94@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b94@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('spending insights', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('generates a spending insight', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/spending-insights/generate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { period: '2024-Q3', category: 'food', totalSpent: '250000', transactionCount: 45, averageAmount: '5555', currency: 'USD', trend: 'INCREASING' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category).toBe('food');
    expect(res.json().totalSpent).toBe('250000');
    expect(res.json().trend).toBe('INCREASING');
  });

  it('lists insights', async () => {
    await ctx.prisma.spendingInsight.create({
      data: { userId: ctx.user.id, period: '2024-Q3', category: 'food', totalSpent: BigInt(250000), transactionCount: 45, averageAmount: BigInt(5555), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/spending-insights/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets insights by period', async () => {
    await ctx.prisma.spendingInsight.create({
      data: { userId: ctx.user.id, period: '2024-Q3', category: 'food', totalSpent: BigInt(250000), transactionCount: 45, averageAmount: BigInt(5555), currency: 'USD' },
    });
    await ctx.prisma.spendingInsight.create({
      data: { userId: ctx.user.id, period: '2024-Q4', category: 'transport', totalSpent: BigInt(100000), transactionCount: 20, averageAmount: BigInt(5000), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/spending-insights/period/2024-Q3',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets insights by category', async () => {
    await ctx.prisma.spendingInsight.create({
      data: { userId: ctx.user.id, period: '2024-Q3', category: 'food', totalSpent: BigInt(250000), transactionCount: 45, averageAmount: BigInt(5555), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/spending-insights/category/food',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('deletes an insight', async () => {
    const insight = await ctx.prisma.spendingInsight.create({
      data: { userId: ctx.user.id, period: '2024-Q3', category: 'food', totalSpent: BigInt(250000), transactionCount: 45, averageAmount: BigInt(5555), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/spending-insights/${insight.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data insight analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/spending-insights/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalInsights).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single insight by id', async () => {
    const insight = await ctx.prisma.spendingInsight.create({
      data: { userId: ctx.user.id, period: '2024-Q3', category: 'utilities', totalSpent: BigInt(80000), transactionCount: 5, averageAmount: BigInt(16000), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/spending-insights/${insight.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category).toBe('utilities');
  });
});

describe('compliance rules', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a compliance rule', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/compliance-rules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Large TX Alert', ruleType: 'TRANSACTION', condition: 'amount > 1000000', action: 'ALERT', severity: 'HIGH' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Large TX Alert');
    expect(res.json().severity).toBe('HIGH');
  });

  it('rejects duplicate rule name', async () => {
    await ctx.prisma.complianceRule.create({
      data: { userId: ctx.user.id, name: 'Large TX Alert', ruleType: 'TRANSACTION', condition: 'amount > 1000000', action: 'ALERT', severity: 'HIGH' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/compliance-rules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Large TX Alert', ruleType: 'TRANSACTION', condition: 'amount > 500000', action: 'BLOCK', severity: 'CRITICAL' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('rule_name_exists');
  });

  it('lists rules', async () => {
    await ctx.prisma.complianceRule.create({
      data: { userId: ctx.user.id, name: 'Rule A', ruleType: 'KYC', condition: 'risk > 80', action: 'REVIEW', severity: 'MEDIUM' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-rules/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('toggles a rule', async () => {
    const rule = await ctx.prisma.complianceRule.create({
      data: { userId: ctx.user.id, name: 'Rule A', ruleType: 'KYC', condition: 'risk > 80', action: 'REVIEW', severity: 'MEDIUM', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-rules/${rule.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('records a trigger', async () => {
    const rule = await ctx.prisma.complianceRule.create({
      data: { userId: ctx.user.id, name: 'Rule A', ruleType: 'KYC', condition: 'risk > 80', action: 'REVIEW', severity: 'MEDIUM', triggerCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-rules/${rule.id}/trigger`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().triggerCount).toBe(1);
  });

  it('deletes a rule', async () => {
    const rule = await ctx.prisma.complianceRule.create({
      data: { userId: ctx.user.id, name: 'Rule A', ruleType: 'KYC', condition: 'risk > 80', action: 'REVIEW', severity: 'MEDIUM' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/compliance-rules/${rule.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data rule analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-rules/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRules).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single rule by id', async () => {
    const rule = await ctx.prisma.complianceRule.create({
      data: { userId: ctx.user.id, name: 'Geo Block', ruleType: 'GEOFENCE', condition: 'country in [BLOCKED]', action: 'BLOCK', severity: 'CRITICAL' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/compliance-rules/${rule.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Geo Block');
  });
});

describe('merchant profiles', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a merchant profile', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-profiles/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { merchantName: 'Acme Corp', merchantCode: 'ACME001', category: 'retail', country: 'US', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().merchantName).toBe('Acme Corp');
    expect(res.json().merchantCode).toBe('ACME001');
    expect(res.json().status).toBe('ACTIVE');
  });

  it('rejects duplicate merchant code', async () => {
    await ctx.prisma.merchantProfile.create({
      data: { userId: ctx.user.id, merchantName: 'Acme Corp', merchantCode: 'ACME001', category: 'retail', country: 'US', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/merchant-profiles/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { merchantName: 'Another Acme', merchantCode: 'ACME001', category: 'tech', country: 'US', currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('merchant_code_exists');
  });

  it('lists merchant profiles', async () => {
    await ctx.prisma.merchantProfile.create({
      data: { userId: ctx.user.id, merchantName: 'Acme', merchantCode: 'ACME001', category: 'retail', country: 'US', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-profiles/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('suspends a merchant', async () => {
    const profile = await ctx.prisma.merchantProfile.create({
      data: { userId: ctx.user.id, merchantName: 'Acme', merchantCode: 'ACME001', category: 'retail', country: 'US', currency: 'USD', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-profiles/${profile.id}/suspend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SUSPENDED');
  });

  it('activates a suspended merchant', async () => {
    const profile = await ctx.prisma.merchantProfile.create({
      data: { userId: ctx.user.id, merchantName: 'Acme', merchantCode: 'ACME001', category: 'retail', country: 'US', currency: 'USD', status: 'SUSPENDED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-profiles/${profile.id}/activate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('records a transaction', async () => {
    const profile = await ctx.prisma.merchantProfile.create({
      data: { userId: ctx.user.id, merchantName: 'Acme', merchantCode: 'ACME001', category: 'retail', country: 'US', currency: 'USD', transactionCount: 0, totalVolume: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/merchant-profiles/${profile.id}/record-transaction`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '50000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionCount).toBe(1);
    expect(res.json().totalVolume).toBe('50000');
  });

  it('returns no_data merchant analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/merchant-profiles/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalMerchants).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single merchant by id', async () => {
    const profile = await ctx.prisma.merchantProfile.create({
      data: { userId: ctx.user.id, merchantName: 'Beta Corp', merchantCode: 'BETA001', category: 'tech', country: 'GB', currency: 'GBP' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/merchant-profiles/${profile.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantName).toBe('Beta Corp');
  });
});
