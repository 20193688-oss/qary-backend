import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryPrisma, createInMemoryRedis, createMockStripe } from './_mocks.js';
import { __test as voiceInternals } from '../src/routes/voice-payment.js';

async function bootstrap() {
  const prisma = createInMemoryPrisma();
  const redis = createInMemoryRedis();
  const stripe = createMockStripe();
  const app = await buildApp({ prisma, redis, stripe: stripe as never });
  await app.ready();

  const reg = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'voice@b.com' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'voice@b.com', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  await app.inject({
    method: 'POST', url: '/api/auth/pin',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { pin: '4242' },
  });

  const order = await prisma.order.create({
    data: {
      userId: user.id, pickup: {}, dropoff: {},
      amountCents: 2500, currency: 'USD',
    },
  } as never) as { id: string };

  await app.inject({
    method: 'POST', url: '/api/payments/intent',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { orderId: order.id, amountCents: 2500 },
  });

  voiceInternals.failureCounts.clear();
  return { app, prisma, accessToken, user, order };
}

describe('voice-confirm', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('valid PIN captures payment and returns TTS message', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/voice-confirm',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { orderId: ctx.order.id, userId: ctx.user.id, confirmPin: '4242' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('SUCCEEDED');
    expect(body.voicePinVerified).toBe(true);
    expect(body.ttsConfirmation).toMatch(/confirmado/i);
    expect(body.receiptUrl).toMatch(/\/api\/receipts\//);
  });

  it('invalid PIN is rejected and audited', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/voice-confirm',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { orderId: ctx.order.id, userId: ctx.user.id, confirmPin: '0000' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_pin');
  });

  it('user_mismatch when token user differs', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/voice-confirm',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { orderId: ctx.order.id, userId: 'someone-else', confirmPin: '4242' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rate-limits after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: 'POST', url: '/api/voice-confirm',
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: { orderId: ctx.order.id, userId: ctx.user.id, confirmPin: '0000' },
      });
    }
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/voice-confirm',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { orderId: ctx.order.id, userId: ctx.user.id, confirmPin: '4242' },
    });
    expect(res.statusCode).toBe(429);
  });
});
