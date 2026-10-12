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
    payload: { email: 'biz@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'biz@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

const BIZ_PAYLOAD = {
  taxId: '20123456789',
  taxIdType: 'RUC',
  taxIdCountry: 'PE',
  legalName: 'Acme Corp S.A.C.',
  tradeName: 'Acme',
  economicActivity: 'Software development',
};

describe('kopera business profiles', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a business profile', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().taxId).toBe('20123456789');
    expect(res.json().legalName).toBe('Acme Corp S.A.C.');
    expect(res.json().status).toBe('PENDING');
  });

  it('prevents duplicate profiles', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('profile_already_exists');
  });

  it('gets business profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().taxId).toBe('20123456789');
  });

  it('returns 404 when no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { tradeName: 'Acme Peru', ciiu: '6201' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tradeName).toBe('Acme Peru');
    expect(res.json().ciiu).toBe('6201');
  });

  it('verifies profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/business-profile/verify',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
    expect(res.json().verifiedAt).toBeTruthy();
  });

  it('prevents double verification', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile/verify',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/business-profile/verify',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_verified');
  });

  it('rejects profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/business-profile',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: BIZ_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/business-profile/reject',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Invalid tax ID' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
    expect(res.json().rejectedReason).toBe('Invalid tax ID');
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/business-profile' });
    expect(res.statusCode).toBe(401);
  });
});
