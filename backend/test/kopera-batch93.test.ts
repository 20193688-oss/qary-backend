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
    payload: { email: 'b93@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b93@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment templates', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payment template', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-templates/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Rent', recipientName: 'Landlord', recipientAccount: 'ACC-123', amount: '150000', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Rent');
    expect(res.json().amount).toBe('150000');
  });

  it('lists templates', async () => {
    await ctx.prisma.paymentTemplate.create({
      data: { userId: ctx.user.id, name: 'Rent', recipientName: 'Landlord', recipientAccount: 'ACC-1', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-templates/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('uses a template and increments usage count', async () => {
    const tpl = await ctx.prisma.paymentTemplate.create({
      data: { userId: ctx.user.id, name: 'Rent', recipientName: 'Landlord', recipientAccount: 'ACC-1', currency: 'USD', isActive: true, usageCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-templates/${tpl.id}/use`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().usageCount).toBe(1);
  });

  it('toggles a template', async () => {
    const tpl = await ctx.prisma.paymentTemplate.create({
      data: { userId: ctx.user.id, name: 'Rent', recipientName: 'Landlord', recipientAccount: 'ACC-1', currency: 'USD', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-templates/${tpl.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('updates a template', async () => {
    const tpl = await ctx.prisma.paymentTemplate.create({
      data: { userId: ctx.user.id, name: 'Rent', recipientName: 'Landlord', recipientAccount: 'ACC-1', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-templates/${tpl.id}/update`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Monthly Rent' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Monthly Rent');
  });

  it('deletes a template', async () => {
    const tpl = await ctx.prisma.paymentTemplate.create({
      data: { userId: ctx.user.id, name: 'Rent', recipientName: 'Landlord', recipientAccount: 'ACC-1', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-templates/${tpl.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data template analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-templates/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTemplates).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single template by id', async () => {
    const tpl = await ctx.prisma.paymentTemplate.create({
      data: { userId: ctx.user.id, name: 'Utilities', recipientName: 'Electric Co', recipientAccount: 'ACC-2', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/payment-templates/${tpl.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Utilities');
  });
});

describe('risk scoring', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a risk assessment', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/risk-scoring/assess',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { entityType: 'transaction', entityId: 'tx-1', riskScore: 75, riskLevel: 'HIGH', factors: ['large_amount', 'new_recipient'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().riskScore).toBe(75);
    expect(res.json().riskLevel).toBe('HIGH');
  });

  it('lists risk assessments', async () => {
    await ctx.prisma.riskAssessment.create({
      data: { userId: ctx.user.id, entityType: 'tx', entityId: 'tx-1', riskScore: 30, riskLevel: 'LOW', factors: '["normal"]' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/risk-scoring/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('updates a risk score', async () => {
    const a = await ctx.prisma.riskAssessment.create({
      data: { userId: ctx.user.id, entityType: 'tx', entityId: 'tx-1', riskScore: 30, riskLevel: 'LOW', factors: '["normal"]', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/risk-scoring/${a.id}/update`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { riskScore: 85, riskLevel: 'CRITICAL', factors: ['suspicious_pattern'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().riskScore).toBe(85);
    expect(res.json().riskLevel).toBe('CRITICAL');
  });

  it('archives an assessment', async () => {
    const a = await ctx.prisma.riskAssessment.create({
      data: { userId: ctx.user.id, entityType: 'tx', entityId: 'tx-1', riskScore: 30, riskLevel: 'LOW', factors: '[]', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/risk-scoring/${a.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARCHIVED');
  });

  it('gets assessments by entity', async () => {
    await ctx.prisma.riskAssessment.create({
      data: { userId: ctx.user.id, entityType: 'wallet', entityId: 'w-1', riskScore: 20, riskLevel: 'LOW', factors: '[]' },
    });
    await ctx.prisma.riskAssessment.create({
      data: { userId: ctx.user.id, entityType: 'transaction', entityId: 'tx-1', riskScore: 80, riskLevel: 'HIGH', factors: '[]' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/risk-scoring/entity/wallet/w-1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('returns no_data risk analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/risk-scoring/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalAssessments).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single assessment by id', async () => {
    const a = await ctx.prisma.riskAssessment.create({
      data: { userId: ctx.user.id, entityType: 'user', entityId: 'u-1', riskScore: 50, riskLevel: 'MEDIUM', factors: '["geo"]' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/risk-scoring/${a.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().riskScore).toBe(50);
  });
});

describe('exchange orders', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an exchange order', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/exchange-orders/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { fromCurrency: 'USD', toCurrency: 'EUR', fromAmount: '100000', exchangeRate: 0.92, orderType: 'MARKET' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().fromCurrency).toBe('USD');
    expect(res.json().toCurrency).toBe('EUR');
    expect(res.json().status).toBe('PENDING');
    expect(res.json().fromAmount).toBe('100000');
  });

  it('lists exchange orders', async () => {
    await ctx.prisma.exchangeOrder.create({
      data: { userId: ctx.user.id, fromCurrency: 'USD', toCurrency: 'EUR', fromAmount: BigInt(100000), toAmount: BigInt(92000), exchangeRate: 0.92, orderType: 'MARKET', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/exchange-orders/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('executes an order', async () => {
    const order = await ctx.prisma.exchangeOrder.create({
      data: { userId: ctx.user.id, fromCurrency: 'USD', toCurrency: 'EUR', fromAmount: BigInt(100000), toAmount: BigInt(92000), exchangeRate: 0.92, orderType: 'MARKET', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/exchange-orders/${order.id}/execute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('EXECUTED');
  });

  it('cancels an order', async () => {
    const order = await ctx.prisma.exchangeOrder.create({
      data: { userId: ctx.user.id, fromCurrency: 'USD', toCurrency: 'GBP', fromAmount: BigInt(50000), toAmount: BigInt(40000), exchangeRate: 0.8, orderType: 'LIMIT', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/exchange-orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('rejects executing non-pending order', async () => {
    const order = await ctx.prisma.exchangeOrder.create({
      data: { userId: ctx.user.id, fromCurrency: 'USD', toCurrency: 'EUR', fromAmount: BigInt(100000), toAmount: BigInt(92000), exchangeRate: 0.92, orderType: 'MARKET', status: 'EXECUTED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/exchange-orders/${order.id}/execute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('order_not_pending');
  });

  it('gets orders by currency pair', async () => {
    await ctx.prisma.exchangeOrder.create({
      data: { userId: ctx.user.id, fromCurrency: 'USD', toCurrency: 'EUR', fromAmount: BigInt(100000), toAmount: BigInt(92000), exchangeRate: 0.92, orderType: 'MARKET', status: 'PENDING' },
    });
    await ctx.prisma.exchangeOrder.create({
      data: { userId: ctx.user.id, fromCurrency: 'USD', toCurrency: 'GBP', fromAmount: BigInt(50000), toAmount: BigInt(40000), exchangeRate: 0.8, orderType: 'MARKET', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/exchange-orders/pair/USD/EUR',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('returns no_data exchange analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/exchange-orders/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalOrders).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single order by id', async () => {
    const order = await ctx.prisma.exchangeOrder.create({
      data: { userId: ctx.user.id, fromCurrency: 'EUR', toCurrency: 'JPY', fromAmount: BigInt(200000), toAmount: BigInt(32000000), exchangeRate: 160, orderType: 'LIMIT', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/exchange-orders/${order.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fromCurrency).toBe('EUR');
    expect(res.json().orderType).toBe('LIMIT');
  });
});
