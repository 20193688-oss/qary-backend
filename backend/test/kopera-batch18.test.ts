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
    payload: { email: 'b18@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b18@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('GET /api/transactions/:id', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns a transaction by ID', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    const dep = await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 100, currency: 'USD' },
    });
    const txnId = dep.json().transactionId;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/transactions/${txnId}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(txnId);
    expect(res.json().type).toBe('DEPOSIT');
  });

  it('returns 404 for nonexistent transaction', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transactions/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/transactions/summary', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns transaction summary for a currency', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/wallets/deposit',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: 200, currency: 'USD' },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transactions/summary?currency=USD',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('USD');
    expect(res.json().totalIn).toBe('20000');
    expect(res.json().count).toBe(1);
  });

  it('requires currency parameter', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transactions/summary',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('currency_required');
  });
});

describe('invoice update (PATCH)', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function createInvoice() {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        type: 'FACTURA', currency: 'USD', subtotal: 100, country: 'PE',
        senderTaxId: '20123456789', senderName: 'Test Corp',
      },
    });
    return res.json();
  }

  it('updates notes and receiver on an issued invoice', async () => {
    const inv = await createInvoice();
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/invoices/${inv.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { notes: 'Payment due in 30 days', receiverName: 'Client Inc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toBe('Payment due in 30 days');
    expect(res.json().receiverName).toBe('Client Inc');
  });

  it('rejects updating a sent invoice', async () => {
    const inv = await createInvoice();
    await ctx.app.inject({
      method: 'POST', url: `/api/invoices/${inv.id}/send`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/invoices/${inv.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { notes: 'Too late' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invoice_not_editable');
  });

  it('includes lineItems and notes in invoice serialization', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoices',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        type: 'BOLETA', currency: 'PEN', subtotal: 50, country: 'PE',
        lineItems: [{ description: 'Widget', quantity: 2, unitPrice: 25, total: 50 }],
        notes: 'Gracias',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().lineItems).toHaveLength(1);
    expect(res.json().lineItems[0].description).toBe('Widget');
    expect(res.json().notes).toBe('Gracias');
  });
});

describe('agent execution output in serialization', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('includes output field in execution response', async () => {
    const exec = await ctx.app.inject({
      method: 'POST', url: '/api/agents/execute',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { agentNumber: 1, input: { text: 'test' } },
    });

    const executions = await ctx.app.inject({
      method: 'GET', url: '/api/agents/executions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(executions.statusCode).toBe(200);
    const list = executions.json();
    expect(list.length).toBeGreaterThan(0);
    expect('output' in list[0]).toBe(true);
  });
});

describe('referral admin list', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists all referrals', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/all',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].referrerId).toBe(ctx.user.id);
    expect(res.json()[0].status).toBe('active');
  });

  it('filters referrals by status', async () => {
    await ctx.app.inject({
      method: 'GET', url: '/api/referrals/my-code',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/referrals/deactivate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const active = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/all?status=active',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().length).toBe(0);

    const inactive = await ctx.app.inject({
      method: 'GET', url: '/api/referrals/all?status=inactive',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(inactive.json().length).toBe(1);
  });
});
