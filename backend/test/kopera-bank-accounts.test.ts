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
    payload: { email: 'banker@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'banker@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

const ACCT_PAYLOAD = {
  bankName: 'BCP', accountNumber: '123456789012', rail: 'CCI',
  country: 'PE', currency: 'PEN', holderName: 'Test User',
};

describe('kopera bank accounts', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('adds a bank account', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().bankName).toBe('BCP');
    expect(res.json().rail).toBe('CCI');
    expect(res.json().isDefault).toBe(true);
    expect(res.json().accountNumberLast4).toBe('9012');
  });

  it('lists bank accounts', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...ACCT_PAYLOAD, accountNumber: '999888777666', bankName: 'BBVA' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets account by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/bank-accounts/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('sets default account', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });
    const c2 = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ...ACCT_PAYLOAD, accountNumber: '111222333444', bankName: 'Interbank' },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${c2.json().id}/default`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isDefault).toBe(true);
  });

  it('verifies an account', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${create.json().id}/verify`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isVerified).toBe(true);
  });

  it('prevents double verification', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });
    const id = create.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${id}/verify`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${id}/verify`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_verified');
  });

  it('removes an account', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/bank-accounts/${create.json().id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('prevents duplicate account', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: ACCT_PAYLOAD,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('account_already_exists');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/bank-accounts' });
    expect(res.statusCode).toBe(401);
  });
});
