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
    payload: { email: 'ben-owner@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'ben-owner@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  const reg2 = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'ben-recipient@kopera.io' },
  });
  const v2 = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'ben-recipient@kopera.io', code: reg2.json().debugOtp },
  });
  const recipient = v2.json().user;

  return { app, prisma, accessToken, user, recipient };
}

describe('kopera beneficiaries', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a beneficiary', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'My Friend', recipientUserId: ctx.recipient.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().nickname).toBe('My Friend');
    expect(res.json().recipientUserId).toBe(ctx.recipient.id);
    expect(res.json().recipientEmail).toBe('ben-recipient@kopera.io');
  });

  it('lists beneficiaries', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Contact 1', recipientUserId: ctx.recipient.id },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets beneficiary by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Buddy', recipientUserId: ctx.recipient.id },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/beneficiaries/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('updates a beneficiary', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Old Name', recipientUserId: ctx.recipient.id },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/beneficiaries/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'New Name', currency: 'USD' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().nickname).toBe('New Name');
    expect(res.json().currency).toBe('USD');
  });

  it('deletes a beneficiary', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'To Delete', recipientUserId: ctx.recipient.id },
    });
    const id = create.json().id;

    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/beneficiaries/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const check = await ctx.app.inject({
      method: 'GET', url: `/api/beneficiaries/${id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(check.statusCode).toBe(404);
  });

  it('rejects adding self as beneficiary', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Myself', recipientUserId: ctx.user.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_add_self');
  });

  it('rejects duplicate beneficiary', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'First', recipientUserId: ctx.recipient.id },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/beneficiaries',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { nickname: 'Duplicate', recipientUserId: ctx.recipient.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('beneficiary_exists');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries',
    });
    expect(res.statusCode).toBe(401);
  });
});
