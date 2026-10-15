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
    payload: { email: 'b107@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b107@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('compliance checks', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a check', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/compliance-checks/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { checkType: 'aml', entityId: 'user-123', entityType: 'user' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().checkType).toBe('AML');
    expect(res.json().entityType).toBe('USER');
    expect(res.json().status).toBe('IN_PROGRESS');
  });

  it('lists checks', async () => {
    await ctx.prisma.complianceCheck.create({
      data: { userId: ctx.user.id, checkType: 'KYC', entityId: 'u-1', entityType: 'USER' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-checks/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('completes a check', async () => {
    const c = await ctx.prisma.complianceCheck.create({
      data: { userId: ctx.user.id, checkType: 'SANCTIONS', entityId: 'u-2', entityType: 'USER', status: 'IN_PROGRESS' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-checks/${c.id}/complete`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { riskLevel: 'LOW', findings: 'No issues found' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('COMPLETED');
    expect(res.json().riskLevel).toBe('LOW');
  });

  it('flags a completed check', async () => {
    const c = await ctx.prisma.complianceCheck.create({
      data: { userId: ctx.user.id, checkType: 'PEP', entityId: 'u-3', entityType: 'MERCHANT', status: 'COMPLETED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-checks/${c.id}/flag`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Suspicious activity detected' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FLAGGED');
    expect(res.json().flagReason).toBe('Suspicious activity detected');
  });

  it('returns no_data check analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-checks/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalChecks).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('account closures', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a closure request', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/account-closures/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Moving to competitor', feedbackMessage: 'Better rates elsewhere' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().reason).toBe('Moving to competitor');
    expect(res.json().status).toBe('PENDING');
  });

  it('lists closure requests', async () => {
    await ctx.prisma.accountClosure.create({
      data: { userId: ctx.user.id, reason: 'No longer needed' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-closures/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('approves a request', async () => {
    const r = await ctx.prisma.accountClosure.create({
      data: { userId: ctx.user.id, reason: 'Closing business', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-closures/${r.id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
  });

  it('processes an approved request', async () => {
    const r = await ctx.prisma.accountClosure.create({
      data: { userId: ctx.user.id, reason: 'Process me', status: 'APPROVED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-closures/${r.id}/process`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CLOSED');
  });

  it('cancels a pending request', async () => {
    const r = await ctx.prisma.accountClosure.create({
      data: { userId: ctx.user.id, reason: 'Changed mind', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-closures/${r.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data closure analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-closures/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRequests).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment gateway configs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a gateway config', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-gateway-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { gatewayName: 'Stripe', environment: 'production', supportedCurrencies: 'USD,EUR,GBP', merchantId: 'acct_123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().gatewayName).toBe('Stripe');
    expect(res.json().environment).toBe('PRODUCTION');
    expect(res.json().totalVolume).toBe('0');
  });

  it('lists gateway configs', async () => {
    await ctx.prisma.paymentGatewayConfig.create({
      data: { userId: ctx.user.id, gatewayName: 'PayPal', environment: 'SANDBOX', supportedCurrencies: 'USD', merchantId: 'pp-1' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-gateway-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records a transaction', async () => {
    const c = await ctx.prisma.paymentGatewayConfig.create({
      data: { userId: ctx.user.id, gatewayName: 'Square', environment: 'PRODUCTION', supportedCurrencies: 'USD', merchantId: 'sq-1', isActive: true, transactionCount: 0, totalVolume: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-gateway-configs/${c.id}/record`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '75000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionCount).toBe(1);
    expect(res.json().totalVolume).toBe('75000');
  });

  it('toggles a gateway off', async () => {
    const c = await ctx.prisma.paymentGatewayConfig.create({
      data: { userId: ctx.user.id, gatewayName: 'Adyen', environment: 'PRODUCTION', supportedCurrencies: 'EUR', merchantId: 'ad-1', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-gateway-configs/${c.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a gateway config', async () => {
    const c = await ctx.prisma.paymentGatewayConfig.create({
      data: { userId: ctx.user.id, gatewayName: 'Delete', environment: 'TEST', supportedCurrencies: 'GBP', merchantId: 'del-1' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payment-gateway-configs/${c.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data gateway analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-gateway-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalGateways).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
