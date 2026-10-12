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
    payload: { email: 'kyc-admin@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'kyc-admin@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

const KYC_PAYLOAD = {
  documentType: 'DNI',
  documentNumber: '12345678',
  documentCountry: 'PE',
  firstName: 'Juan',
  lastName: 'Perez',
};

describe('kopera kyc admin actions', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('approves a KYC profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: KYC_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
    expect(res.json().verifiedAt).toBeTruthy();
    expect(res.json().pepCheck).toBe(true);
    expect(res.json().sanctionsCheck).toBe(true);
  });

  it('prevents double approval', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: KYC_PAYLOAD,
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_approved');
  });

  it('rejects a KYC profile', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: KYC_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/reject',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Document expired' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
    expect(res.json().rejectedReason).toBe('Document expired');
  });

  it('returns 404 when approving non-existent KYC', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/approve',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('kyc_not_found');
  });

  it('returns 404 when rejecting non-existent KYC', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/reject',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Invalid' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('kyc_not_found');
  });

  it('uploads document URLs', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: KYC_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/documents',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentFrontUrl: 'https://storage.example.com/front.jpg',
        selfieUrl: 'https://storage.example.com/selfie.jpg',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentFrontUrl).toBe('https://storage.example.com/front.jpg');
    expect(res.json().selfieUrl).toBe('https://storage.example.com/selfie.jpg');
  });

  it('returns 404 when uploading docs without KYC started', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/documents',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { documentFrontUrl: 'https://storage.example.com/front.jpg' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('sets risk score', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: KYC_PAYLOAD,
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/risk-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { riskScore: 25.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().riskScore).toBe(25.5);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/kyc/approve' });
    expect(res.statusCode).toBe(401);
  });
});
