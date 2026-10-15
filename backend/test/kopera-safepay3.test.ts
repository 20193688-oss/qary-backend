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
    payload: { email: 'sp3@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'sp3@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('fraud alert system', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a fraud alert', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fraud-alerts/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { alertType: 'SUSPICIOUS_LOGIN', severity: 'HIGH', description: 'Login from unknown device' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().alertType).toBe('SUSPICIOUS_LOGIN');
    expect(res.json().status).toBe('OPEN');
  });

  it('lists alerts', async () => {
    await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'UNUSUAL_AMOUNT', severity: 'MEDIUM', description: 'Large transaction' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fraud-alerts/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('resolves an alert', async () => {
    const alert = await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'SUSPICIOUS_LOGIN', severity: 'HIGH', description: 'Test' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/fraud-alerts/${alert.id}/resolve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { resolution: 'False positive - known device' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('RESOLVED');
  });

  it('escalates an alert', async () => {
    const alert = await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'SUSPICIOUS_LOGIN', severity: 'HIGH', description: 'Test' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/fraud-alerts/${alert.id}/escalate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ESCALATED');
    expect(res.json().severity).toBe('CRITICAL');
  });

  it('runs auto-block check - allows', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fraud-alerts/auto-block-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionId: 'txn1', amount: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shouldBlock).toBe(false);
    expect(res.json().recommendation).toBe('ALLOW');
  });

  it('runs auto-block check - blocks with critical alerts', async () => {
    await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'FRAUD', severity: 'CRITICAL', description: 'Confirmed fraud' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fraud-alerts/auto-block-check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionId: 'txn2', amount: 5000000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shouldBlock).toBe(true);
    expect(res.json().recommendation).toBe('BLOCK');
  });

  it('returns no_data analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fraud-alerts/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalAlerts).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('returns analytics with alerts', async () => {
    await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'SUSPICIOUS', severity: 'HIGH', description: 'A' },
    });
    await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'FRAUD', severity: 'CRITICAL', description: 'B', status: 'RESOLVED' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fraud-alerts/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAlerts).toBe(2);
    expect(body.breakdown.open).toBe(1);
    expect(body.breakdown.resolved).toBe(1);
    expect(body.analyticsLevel).toBe('attention_needed');
  });
});

describe('secret key management', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a secret key', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/secret-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secretKey: 'mySecretKey123', label: 'Primary' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBe('Primary');
    expect(res.json().isActive).toBe(true);
  });

  it('rejects short key', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/secret-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secretKey: 'ab' },
    });
    expect([400, 500]).toContain(res.statusCode);
  });

  it('validates a correct key', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/secret-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secretKey: 'mySecretKey123' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/secret-keys/validate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secretKey: 'mySecretKey123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it('rejects invalid key', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/secret-keys/validate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secretKey: 'wrongKey' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  it('revokes a key', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/secret-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secretKey: 'mySecretKey123' },
    });
    const keyId = create.json().id;
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/secret-keys/${keyId}/revoke`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('returns security report with no keys', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/secret-keys/report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().securityLevel).toBe('no_key');
    expect(res.json().hasActiveKey).toBe(false);
  });

  it('returns security report with active key', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/secret-keys/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { secretKey: 'mySecretKey123' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/secret-keys/report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().securityLevel).toBe('strong');
    expect(res.json().activeKeys).toBe(1);
  });
});

describe('post-fraud audit & recovery', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an audit case', async () => {
    const alert = await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'FRAUD', severity: 'HIGH', description: 'Unauthorized transaction' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/post-fraud/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { fraudAlertId: alert.id, reportedAmount: 500000, currency: 'USD', description: 'Unauthorized charge' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('OPEN');
    expect(res.json().phase).toBe('INVESTIGATION');
    expect(res.json().reportedAmount).toBe('500000');
  });

  it('updates audit phase', async () => {
    const alert = await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'FRAUD', severity: 'HIGH', description: 'Test' },
    });
    const audit = await ctx.prisma.postFraudAudit.create({
      data: { userId: ctx.user.id, fraudAlertId: alert.id, reportedAmount: BigInt(500000), currency: 'USD', description: 'Test' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/post-fraud/${audit.id}/phase`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { phase: 'RECOVERY' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phase).toBe('RECOVERY');
  });

  it('records fund recovery', async () => {
    const alert = await ctx.prisma.fraudAlert.create({
      data: { userId: ctx.user.id, alertType: 'FRAUD', severity: 'HIGH', description: 'Test' },
    });
    const audit = await ctx.prisma.postFraudAudit.create({
      data: { userId: ctx.user.id, fraudAlertId: alert.id, reportedAmount: BigInt(500000), currency: 'USD', description: 'Test' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/post-fraud/${audit.id}/recovery`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recoveredAmount: 300000, method: 'chargeback', notes: 'Visa chargeback processed' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recoveredAmount).toBe('300000');
    expect(res.json().method).toBe('chargeback');
  });

  it('returns no_data recovery analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/post-fraud/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCases).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('returns recovery analytics with cases', async () => {
    await ctx.prisma.postFraudAudit.create({
      data: { userId: ctx.user.id, fraudAlertId: 'a1', reportedAmount: BigInt(500000), currency: 'USD', description: 'Case A', totalRecovered: BigInt(400000), status: 'CLOSED' },
    });
    await ctx.prisma.postFraudAudit.create({
      data: { userId: ctx.user.id, fraudAlertId: 'a2', reportedAmount: BigInt(200000), currency: 'USD', description: 'Case B', totalRecovered: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/post-fraud/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCases).toBe(2);
    expect(body.totalReported).toBe('700000');
    expect(body.totalRecovered).toBe('400000');
    expect(body.recoveryRate).toBeGreaterThan(0);
  });
});
