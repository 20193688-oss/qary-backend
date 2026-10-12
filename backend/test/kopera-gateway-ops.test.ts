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
    payload: { email: 'gateway-ops@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'gateway-ops@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

async function createPayment(ctx: Awaited<ReturnType<typeof bootstrap>>, overrides?: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/gateway/payments',
    headers: { authorization: `Bearer ${ctx.accessToken}` },
    payload: {
      amount: 50,
      currency: 'USD',
      paymentMethod: 'CARD',
      ...overrides,
    },
  });
  return res.json();
}

describe('kopera gateway operations', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('captures a REQUIRES_ACTION payment', async () => {
    const tables = (ctx.prisma as any).__tables;
    const payment = await createPayment(ctx);

    // Manually set status to REQUIRES_ACTION to test capture
    const gp = tables.gatewayPayment.find((g: any) => g.id === payment.id);
    if (gp) gp.status = 'REQUIRES_ACTION';
    const txn = tables.transaction.find((t: any) => t.id === gp.transactionId);
    if (txn) txn.status = 'PROCESSING';

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/capture`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CAPTURED');
  });

  it('rejects capture on already captured payment', async () => {
    const payment = await createPayment(ctx);

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/capture`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_capture');
  });

  it('voids a payment', async () => {
    const tables = (ctx.prisma as any).__tables;
    const payment = await createPayment(ctx);

    const gp = tables.gatewayPayment.find((g: any) => g.id === payment.id);
    if (gp) gp.status = 'REQUIRES_ACTION';

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/void`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('rejects void on settled payment', async () => {
    const tables = (ctx.prisma as any).__tables;
    const payment = await createPayment(ctx);

    const gp = tables.gatewayPayment.find((g: any) => g.id === payment.id);
    if (gp) gp.status = 'SETTLED';

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/void`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_void');
  });

  it('settles a captured payment', async () => {
    const payment = await createPayment(ctx);

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/settle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SETTLED');
    expect(res.json().settledAt).toBeTruthy();
    expect(res.json().settlementAmount).toBe('5000');
  });

  it('settles with custom settlement amount', async () => {
    const payment = await createPayment(ctx);

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/settle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { settlementAmount: 48, settlementCurrency: 'EUR' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settlementAmount).toBe('4800');
    expect(res.json().settlementCurrency).toBe('EUR');
  });

  it('rejects settle on non-captured payment', async () => {
    const tables = (ctx.prisma as any).__tables;
    const payment = await createPayment(ctx);

    const gp = tables.gatewayPayment.find((g: any) => g.id === payment.id);
    if (gp) gp.status = 'REQUIRES_ACTION';

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/settle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_settle');
  });

  it('refunds a captured payment', async () => {
    const payment = await createPayment(ctx);

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/refund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Customer request' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().refunded).toBe(true);
    expect(res.json().amount).toBe('5000');
  });

  it('refunds with partial amount', async () => {
    const payment = await createPayment(ctx);

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/refund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 20 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe('2000');
  });

  it('rejects refund on non-captured payment', async () => {
    const tables = (ctx.prisma as any).__tables;
    const payment = await createPayment(ctx);

    const gp = tables.gatewayPayment.find((g: any) => g.id === payment.id);
    if (gp) gp.status = 'REQUIRES_ACTION';

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/gateway/payments/${payment.id}/refund`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_refund_status');
  });

  it('returns 404 for non-existent payment capture', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments/nonexistent/capture',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for non-existent payment void', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments/nonexistent/void',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth for capture', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gateway/payments/some-id/capture',
    });
    expect(res.statusCode).toBe(401);
  });
});
