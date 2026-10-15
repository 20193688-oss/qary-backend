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
    payload: { email: 'b89@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b89@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('compliance reports', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('generates a compliance report', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/compliance-reports/generate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        reportType: 'AML',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-12-31T23:59:59Z',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().reportType).toBe('AML');
    expect(res.json().status).toBe('COMPLETED');
    expect(res.json().riskFlag).toBe('LOW');
  });

  it('lists compliance reports', async () => {
    await ctx.prisma.complianceReport.create({
      data: {
        userId: ctx.user.id,
        reportType: 'PERIODIC',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-06-30'),
        transactionCount: 5,
        totalVolume: BigInt(500000),
        riskFlag: 'LOW',
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-reports/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].totalVolume).toBe('500000');
  });

  it('flags a report', async () => {
    const report = await ctx.prisma.complianceReport.create({
      data: {
        userId: ctx.user.id,
        reportType: 'AML',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-06-30'),
        riskFlag: 'HIGH',
      },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-reports/${report.id}/flag`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { notes: 'Suspicious pattern detected' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FLAGGED');
  });

  it('archives a report', async () => {
    const report = await ctx.prisma.complianceReport.create({
      data: {
        userId: ctx.user.id,
        reportType: 'RISK_ASSESSMENT',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-06-30'),
        riskFlag: 'LOW',
      },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/compliance-reports/${report.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARCHIVED');
  });

  it('returns no_data compliance summary', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-reports/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalReports).toBe(0);
    expect(res.json().complianceLevel).toBe('no_data');
  });

  it('returns compliance summary with data', async () => {
    await ctx.prisma.complianceReport.create({
      data: { userId: ctx.user.id, reportType: 'AML', periodStart: new Date(), periodEnd: new Date(), riskFlag: 'LOW', totalVolume: BigInt(100000) },
    });
    await ctx.prisma.complianceReport.create({
      data: { userId: ctx.user.id, reportType: 'PERIODIC', periodStart: new Date(), periodEnd: new Date(), riskFlag: 'LOW', totalVolume: BigInt(200000) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/compliance-reports/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalReports).toBe(2);
    expect(res.json().complianceLevel).toBe('excellent');
  });

  it('gets a single report by id', async () => {
    const report = await ctx.prisma.complianceReport.create({
      data: {
        userId: ctx.user.id,
        reportType: 'TRANSACTION_MONITORING',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-06-30'),
        riskFlag: 'MEDIUM',
        totalVolume: BigInt(750000),
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/compliance-reports/${report.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reportType).toBe('TRANSACTION_MONITORING');
    expect(res.json().totalVolume).toBe('750000');
  });
});

describe('account statements', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('generates a statement', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(1000000) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/account-statements/generate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        walletId: wallet.id,
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-12-31T23:59:59Z',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('GENERATED');
    expect(res.json().currency).toBe('USD');
  });

  it('rejects statement for nonexistent wallet', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/account-statements/generate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        walletId: 'nonexistent',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-12-31T23:59:59Z',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists statements', async () => {
    await ctx.prisma.accountStatement.create({
      data: {
        userId: ctx.user.id,
        walletId: 'w1',
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-06-30'),
        currency: 'USD',
        openingBalance: BigInt(100000),
        closingBalance: BigInt(150000),
        totalCredits: BigInt(80000),
        totalDebits: BigInt(30000),
        transactionCount: 10,
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-statements/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].openingBalance).toBe('100000');
    expect(res.json()[0].totalCredits).toBe('80000');
  });

  it('downloads a statement', async () => {
    const st = await ctx.prisma.accountStatement.create({
      data: {
        userId: ctx.user.id,
        walletId: 'w1',
        periodStart: new Date(),
        periodEnd: new Date(),
        currency: 'USD',
      },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-statements/${st.id}/download`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data statement analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-statements/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalStatements).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single statement by id', async () => {
    const st = await ctx.prisma.accountStatement.create({
      data: {
        userId: ctx.user.id,
        walletId: 'w1',
        periodStart: new Date(),
        periodEnd: new Date(),
        currency: 'EUR',
        totalCredits: BigInt(50000),
        totalDebits: BigInt(20000),
      },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/account-statements/${st.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('EUR');
    expect(res.json().totalCredits).toBe('50000');
  });
});

describe('webhook configurations', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a webhook config', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/webhook-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { url: 'https://example.com/hook', events: ['payment.completed', 'refund.created'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe('https://example.com/hook');
    expect(res.json().secret).toBeTruthy();
    expect(res.json().secretHash).toBeUndefined();
  });

  it('rejects duplicate webhook URL', async () => {
    await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/hook', events: '["payment.completed"]', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/webhook-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { url: 'https://example.com/hook', events: ['payment.completed'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('webhook_url_exists');
  });

  it('lists webhooks', async () => {
    await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/a', events: '["a"]', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/webhook-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].events).toEqual(['a']);
  });

  it('updates a webhook', async () => {
    const wh = await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/a', events: '["a"]', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/webhook-configs/${wh.id}/update`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { events: ['a', 'b', 'c'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual(['a', 'b', 'c']);
  });

  it('deactivates a webhook', async () => {
    const wh = await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/a', events: '["a"]', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/webhook-configs/${wh.id}/deactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('rotates a webhook secret', async () => {
    const wh = await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/a', events: '["a"]', isActive: true, secretHash: 'oldhash' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/webhook-configs/${wh.id}/rotate-secret`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toBeTruthy();
  });

  it('records a delivery', async () => {
    const wh = await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/a', events: '["a"]', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/webhook-configs/${wh.id}/delivery`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { eventType: 'payment.completed', payload: '{}', statusCode: 200, success: true, responseTime: 150 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().eventType).toBe('payment.completed');
  });

  it('gets delivery log', async () => {
    const wh = await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/a', events: '["a"]', isActive: true },
    });
    await ctx.prisma.webhookDelivery.create({
      data: { webhookId: wh.id, userId: ctx.user.id, eventType: 'test', payload: '{}', statusCode: 200, success: true, responseTimeMs: 100 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/webhook-configs/${wh.id}/deliveries`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('returns no_data webhook analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/webhook-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalWebhooks).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('returns webhook analytics with data', async () => {
    await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/a', events: '["a"]', isActive: true },
    });
    await ctx.prisma.webhookDelivery.create({
      data: { webhookId: 'wh1', userId: ctx.user.id, eventType: 'test', payload: '{}', statusCode: 200, success: true, responseTimeMs: 100 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/webhook-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalWebhooks).toBe(1);
    expect(res.json().totalDeliveries).toBe(1);
    expect(res.json().successRate).toBe(100);
  });

  it('gets a single webhook by id', async () => {
    const wh = await ctx.prisma.webhookConfig.create({
      data: { userId: ctx.user.id, url: 'https://example.com/detail', events: '["x","y"]', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/webhook-configs/${wh.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe('https://example.com/detail');
    expect(res.json().events).toEqual(['x', 'y']);
  });
});
