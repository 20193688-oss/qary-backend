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
    payload: { email: 'invoice@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'invoice@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('kopera invoices', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an invoice (boleta)', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        type: 'BOLETA',
        currency: 'PEN',
        subtotal: 1000,
        country: 'PE',
        senderName: 'Test Corp',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.type).toBe('BOLETA');
    expect(body.currency).toBe('PEN');
    expect(body.xmlHash).toBeTruthy();
    expect(body.series).toMatch(/^B001/);
  });

  it('creates a factura with tax', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        type: 'FACTURA',
        currency: 'PEN',
        subtotal: 5000,
        country: 'PE',
        senderTaxId: '20193688001',
        senderName: 'Kopera SAC',
        receiverTaxId: '10987654321',
        receiverName: 'Cliente SAC',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.series).toMatch(/^F001/);
    expect(Number(body.taxAmount)).toBeGreaterThan(0);
    expect(Number(body.totalAmount)).toBeGreaterThan(Number(body.subtotal));
  });

  it('lists invoices', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'BOLETA', currency: 'PEN', subtotal: 100, country: 'PE' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets invoice by id', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'RECIBO', currency: 'USD', subtotal: 250, country: 'US' },
    });
    const invoiceId = create.json().id;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/invoices/${invoiceId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(invoiceId);
  });

  it('returns 404 for non-existent invoice', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('marks invoice as sent', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { type: 'BOLETA', currency: 'PEN', subtotal: 500, country: 'PE' },
    });
    const invoiceId = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${invoiceId}/send`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sentAt).toBeTruthy();
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoices',
    });
    expect(res.statusCode).toBe(401);
  });
});
