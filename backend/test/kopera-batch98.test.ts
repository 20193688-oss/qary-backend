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
    payload: { email: 'b98@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b98@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('payment splits', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payment split', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-splits/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        description: 'Dinner split', totalAmount: '100000', currency: 'USD',
        recipients: [
          { name: 'Alice', accountId: 'acc-1', share: 0.5 },
          { name: 'Bob', accountId: 'acc-2', share: 0.5 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalAmount).toBe('100000');
    expect(res.json().recipientCount).toBe(2);
  });

  it('rejects shares not equal to 1', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-splits/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        description: 'Bad split', totalAmount: '100000', currency: 'USD',
        recipients: [
          { name: 'Alice', accountId: 'acc-1', share: 0.3 },
          { name: 'Bob', accountId: 'acc-2', share: 0.3 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('shares_must_equal_one');
  });

  it('lists payment splits', async () => {
    await ctx.prisma.paymentSplit.create({
      data: { userId: ctx.user.id, description: 'Test', totalAmount: BigInt(50000), currency: 'USD', recipientCount: 2, status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-splits/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('executes a split', async () => {
    const split = await ctx.prisma.paymentSplit.create({
      data: { userId: ctx.user.id, description: 'Test', totalAmount: BigInt(100000), currency: 'USD', recipientCount: 2, status: 'PENDING' },
    });
    await ctx.prisma.paymentSplitRecipient.create({
      data: { splitId: split.id, name: 'Alice', accountId: 'acc-1', share: 0.5, amount: BigInt(50000), status: 'PENDING' },
    });
    await ctx.prisma.paymentSplitRecipient.create({
      data: { splitId: split.id, name: 'Bob', accountId: 'acc-2', share: 0.5, amount: BigInt(50000), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-splits/${split.id}/execute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('COMPLETED');
  });

  it('cancels a split', async () => {
    const split = await ctx.prisma.paymentSplit.create({
      data: { userId: ctx.user.id, description: 'Test', totalAmount: BigInt(80000), currency: 'USD', recipientCount: 2, status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-splits/${split.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('gets split recipients', async () => {
    const split = await ctx.prisma.paymentSplit.create({
      data: { userId: ctx.user.id, description: 'Test', totalAmount: BigInt(60000), currency: 'USD', recipientCount: 1, status: 'PENDING' },
    });
    await ctx.prisma.paymentSplitRecipient.create({
      data: { splitId: split.id, name: 'Alice', accountId: 'acc-1', share: 1.0, amount: BigInt(60000), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/payment-splits/${split.id}/recipients`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].amount).toBe('60000');
  });

  it('returns no_data split analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-splits/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalSplits).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('account verifications', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('initiates a verification', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/account-verifications/initiate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { verificationType: 'EMAIL', method: 'OTP', target: 'user@test.com' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().verificationType).toBe('EMAIL');
    expect(res.json().status).toBe('PENDING');
    expect(res.json().code).toHaveLength(6);
  });

  it('confirms a verification with correct code', async () => {
    const v = await ctx.prisma.accountVerification.create({
      data: { userId: ctx.user.id, verificationType: 'EMAIL', method: 'OTP', target: 'a@b.com', code: '123456', status: 'PENDING', attempts: 0, maxAttempts: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-verifications/${v.id}/confirm`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { code: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('VERIFIED');
  });

  it('rejects invalid verification code', async () => {
    const v = await ctx.prisma.accountVerification.create({
      data: { userId: ctx.user.id, verificationType: 'PHONE', method: 'OTP', target: '+1234567890', code: '654321', status: 'PENDING', attempts: 0, maxAttempts: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-verifications/${v.id}/confirm`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_verification_code');
  });

  it('lists verifications', async () => {
    await ctx.prisma.accountVerification.create({
      data: { userId: ctx.user.id, verificationType: 'EMAIL', method: 'OTP', target: 'a@b.com', code: '111111', status: 'PENDING', attempts: 0, maxAttempts: 5 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-verifications/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('cancels a verification', async () => {
    const v = await ctx.prisma.accountVerification.create({
      data: { userId: ctx.user.id, verificationType: 'EMAIL', method: 'LINK', target: 'x@y.com', code: '222222', status: 'PENDING', attempts: 0, maxAttempts: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-verifications/${v.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('resends verification code', async () => {
    const v = await ctx.prisma.accountVerification.create({
      data: { userId: ctx.user.id, verificationType: 'PHONE', method: 'OTP', target: '+999', code: '333333', status: 'PENDING', attempts: 2, maxAttempts: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-verifications/${v.id}/resend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attempts).toBe(0);
  });

  it('returns no_data verification analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-verifications/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalVerifications).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('wire transfers', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('initiates a wire transfer', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/wire-transfers/initiate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recipientName: 'Corp Inc', recipientBank: 'Chase', recipientAccount: 'ACC-999', amount: '5000000', currency: 'USD', swiftCode: 'CHASUS33' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipientName).toBe('Corp Inc');
    expect(res.json().amount).toBe('5000000');
    expect(res.json().status).toBe('INITIATED');
    expect(Number(res.json().fee)).toBeGreaterThan(0);
  });

  it('lists wire transfers', async () => {
    await ctx.prisma.wireTransfer.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientBank: 'BOA', recipientAccount: 'ACC-1', amount: BigInt(100000), currency: 'USD', status: 'INITIATED' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wire-transfers/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('approves a wire transfer', async () => {
    const t = await ctx.prisma.wireTransfer.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientBank: 'BOA', recipientAccount: 'ACC-1', amount: BigInt(200000), currency: 'USD', status: 'INITIATED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/wire-transfers/${t.id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
  });

  it('completes an approved wire transfer', async () => {
    const t = await ctx.prisma.wireTransfer.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientBank: 'WF', recipientAccount: 'ACC-2', amount: BigInt(300000), currency: 'USD', status: 'APPROVED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/wire-transfers/${t.id}/complete`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('COMPLETED');
  });

  it('cancels a wire transfer', async () => {
    const t = await ctx.prisma.wireTransfer.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientBank: 'HSBC', recipientAccount: 'ACC-3', amount: BigInt(400000), currency: 'GBP', status: 'INITIATED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/wire-transfers/${t.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('rejects cancelling a completed transfer', async () => {
    const t = await ctx.prisma.wireTransfer.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientBank: 'DB', recipientAccount: 'ACC-4', amount: BigInt(500000), currency: 'EUR', status: 'COMPLETED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/wire-transfers/${t.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('wire_already_completed');
  });

  it('returns no_data wire analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wire-transfers/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTransfers).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
