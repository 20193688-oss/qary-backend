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
    payload: { email: 'dispute@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'dispute@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  const gp = await (prisma as any).gatewayPayment.create({
    data: {
      transactionId: 'tx-test',
      gateway: 'stripe',
      externalId: 'pi_test_123',
      status: 'CAPTURED',
      amount: BigInt(5000),
      currency: 'USD',
    },
  });

  return { app, prisma, accessToken, user, gatewayPaymentId: gp.id };
}

describe('kopera disputes', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a dispute', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        gatewayPaymentId: ctx.gatewayPaymentId,
        reason: 'Unauthorized charge',
        amount: 50,
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('OPENED');
    expect(body.reason).toBe('Unauthorized charge');
    expect(body.amount).toBe('5000');
  });

  it('prevents duplicate disputes', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        gatewayPaymentId: ctx.gatewayPaymentId,
        reason: 'Unauthorized charge',
        amount: 50, currency: 'USD',
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        gatewayPaymentId: ctx.gatewayPaymentId,
        reason: 'Duplicate',
        amount: 50, currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('dispute_already_exists');
  });

  it('lists user disputes', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        gatewayPaymentId: ctx.gatewayPaymentId,
        reason: 'Not received',
        amount: 50, currency: 'USD',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets dispute by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        gatewayPaymentId: ctx.gatewayPaymentId,
        reason: 'Defective',
        amount: 50, currency: 'USD',
      },
    });
    const disputeId = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/disputes/${disputeId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(disputeId);
  });

  it('submits evidence', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        gatewayPaymentId: ctx.gatewayPaymentId,
        reason: 'Wrong item',
        amount: 50, currency: 'USD',
      },
    });
    const disputeId = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${disputeId}/evidence`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { evidence: { description: 'Photo of wrong item', url: 'https://example.com/photo.jpg' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('UNDER_REVIEW');
    expect(res.json().evidenceSubmitted).toBeTruthy();
  });

  it('escalates a dispute', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/disputes',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        gatewayPaymentId: ctx.gatewayPaymentId,
        reason: 'Not delivered',
        amount: 50, currency: 'USD',
      },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/disputes/${create.json().id}/escalate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('EVIDENCE_NEEDED');
  });

  it('returns 404 for non-existent dispute', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes',
    });
    expect(res.statusCode).toBe(401);
  });
});
