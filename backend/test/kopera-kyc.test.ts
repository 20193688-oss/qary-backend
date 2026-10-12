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
    payload: { email: 'kyc@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'kyc@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera kyc/kyb', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('starts KYC verification', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'DNI',
        documentNumber: '12345678',
        documentCountry: 'PE',
        firstName: 'Test',
        lastName: 'User',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('IN_REVIEW');
    expect(body.documentType).toBe('DNI');
  });

  it('gets KYC status after starting', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyc/start',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        documentType: 'PASSPORT',
        documentNumber: 'AB1234567',
        documentCountry: 'US',
        firstName: 'Jane',
        lastName: 'Doe',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('IN_REVIEW');
    expect(res.json().documentType).toBe('PASSPORT');
  });

  it('returns 404 when KYC not started', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyc/status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('kyc_not_started');
  });

  it('registers a business (KYB)', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/kyb/register',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        taxId: '20193688001',
        taxIdType: 'RUC',
        taxIdCountry: 'PE',
        tradeName: 'Test Corp',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().taxId).toBe('20193688001');
    expect(res.json().status).toBe('IN_REVIEW');
  });

  it('gets KYB status', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/kyb/register',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        taxId: '20193688001',
        taxIdType: 'RUC',
        taxIdCountry: 'PE',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyb/status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().taxId).toBe('20193688001');
  });

  it('returns 404 when KYB not started', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/kyb/status',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('kyb_not_started');
  });

  it('requires auth on all endpoints', async () => {
    const endpoints = [
      { method: 'POST' as const, url: '/api/kyc/start', payload: { documentType: 'DNI', documentNumber: '1', documentCountry: 'PE', firstName: 'A', lastName: 'B' } },
      { method: 'GET' as const, url: '/api/kyc/status' },
      { method: 'POST' as const, url: '/api/kyb/register', payload: { taxId: '1', taxIdType: 'RUC', taxIdCountry: 'PE' } },
      { method: 'GET' as const, url: '/api/kyb/status' },
    ];
    for (const ep of endpoints) {
      const res = await ctx.app.inject(ep);
      expect(res.statusCode).toBe(401);
    }
  });
});
