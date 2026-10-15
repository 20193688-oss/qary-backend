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
    payload: { email: 'b96@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b96@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('recurring invoices', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a recurring invoice', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/recurring-invoices/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recipientName: 'Acme Corp', recipientEmail: 'billing@acme.com', amount: '500000', currency: 'USD', interval: 'MONTHLY', startDate: '2025-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipientName).toBe('Acme Corp');
    expect(res.json().amount).toBe('500000');
    expect(res.json().interval).toBe('MONTHLY');
  });

  it('lists recurring invoices', async () => {
    await ctx.prisma.recurringInvoice.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientEmail: 'a@b.com', amount: BigInt(10000), currency: 'USD', interval: 'WEEKLY', startDate: new Date(), nextDueDate: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/recurring-invoices/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('issues next invoice', async () => {
    const rec = await ctx.prisma.recurringInvoice.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientEmail: 'a@b.com', amount: BigInt(10000), currency: 'USD', interval: 'MONTHLY', startDate: new Date(), nextDueDate: new Date(), status: 'ACTIVE', issuedCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-invoices/${rec.id}/issue`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issuedCount).toBe(1);
  });

  it('pauses a recurring invoice', async () => {
    const rec = await ctx.prisma.recurringInvoice.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientEmail: 'a@b.com', amount: BigInt(10000), currency: 'USD', interval: 'WEEKLY', startDate: new Date(), nextDueDate: new Date(), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-invoices/${rec.id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAUSED');
  });

  it('resumes a paused recurring invoice', async () => {
    const rec = await ctx.prisma.recurringInvoice.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientEmail: 'a@b.com', amount: BigInt(10000), currency: 'USD', interval: 'WEEKLY', startDate: new Date(), nextDueDate: new Date(), status: 'PAUSED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-invoices/${rec.id}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('cancels a recurring invoice', async () => {
    const rec = await ctx.prisma.recurringInvoice.create({
      data: { userId: ctx.user.id, recipientName: 'Test', recipientEmail: 'a@b.com', amount: BigInt(10000), currency: 'USD', interval: 'WEEKLY', startDate: new Date(), nextDueDate: new Date(), status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-invoices/${rec.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data recurring analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/recurring-invoices/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRecurring).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('virtual cards', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('issues a virtual card', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/virtual-cards/issue',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { cardName: 'Travel Card', currency: 'USD', spendingLimit: '1000000', expiresAt: '2026-12-31T00:00:00Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().cardName).toBe('Travel Card');
    expect(res.json().spendingLimit).toBe('1000000');
    expect(res.json().last4).toHaveLength(4);
  });

  it('lists virtual cards', async () => {
    await ctx.prisma.virtualCard.create({
      data: { userId: ctx.user.id, cardName: 'Test', cardHash: 'abc123', last4: '1234', currency: 'USD', spendingLimit: BigInt(500000), currentSpend: BigInt(0), status: 'ACTIVE', expiresAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/virtual-cards/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].spendingLimit).toBe('500000');
  });

  it('records spending on a card', async () => {
    const card = await ctx.prisma.virtualCard.create({
      data: { userId: ctx.user.id, cardName: 'Test', cardHash: 'abc', last4: '9999', currency: 'USD', spendingLimit: BigInt(500000), currentSpend: BigInt(0), status: 'ACTIVE', expiresAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/virtual-cards/${card.id}/spend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '50000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentSpend).toBe('50000');
  });

  it('rejects spending over limit', async () => {
    const card = await ctx.prisma.virtualCard.create({
      data: { userId: ctx.user.id, cardName: 'Test', cardHash: 'abc', last4: '9999', currency: 'USD', spendingLimit: BigInt(100), currentSpend: BigInt(0), status: 'ACTIVE', expiresAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/virtual-cards/${card.id}/spend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '200' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('spending_limit_exceeded');
  });

  it('freezes a card', async () => {
    const card = await ctx.prisma.virtualCard.create({
      data: { userId: ctx.user.id, cardName: 'Test', cardHash: 'abc', last4: '9999', currency: 'USD', spendingLimit: BigInt(500000), currentSpend: BigInt(0), status: 'ACTIVE', expiresAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/virtual-cards/${card.id}/freeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FROZEN');
  });

  it('unfreezes a frozen card', async () => {
    const card = await ctx.prisma.virtualCard.create({
      data: { userId: ctx.user.id, cardName: 'Test', cardHash: 'abc', last4: '9999', currency: 'USD', spendingLimit: BigInt(500000), currentSpend: BigInt(0), status: 'FROZEN', expiresAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/virtual-cards/${card.id}/unfreeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('cancels a card', async () => {
    const card = await ctx.prisma.virtualCard.create({
      data: { userId: ctx.user.id, cardName: 'Test', cardHash: 'abc', last4: '9999', currency: 'USD', spendingLimit: BigInt(500000), currentSpend: BigInt(0), status: 'ACTIVE', expiresAt: new Date() },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/virtual-cards/${card.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data card analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/virtual-cards/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCards).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('tax configs', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a tax config', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/tax-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxType: 'VAT', jurisdiction: 'GB', rate: 0.2, currency: 'GBP' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().taxType).toBe('VAT');
    expect(res.json().jurisdiction).toBe('GB');
    expect(res.json().rate).toBe(0.2);
  });

  it('rejects duplicate tax config', async () => {
    await ctx.prisma.taxConfig.create({
      data: { userId: ctx.user.id, taxType: 'VAT', jurisdiction: 'GB', rate: 0.2, currency: 'GBP' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/tax-configs/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxType: 'VAT', jurisdiction: 'GB', rate: 0.15, currency: 'GBP' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('tax_config_exists');
  });

  it('lists tax configs', async () => {
    await ctx.prisma.taxConfig.create({
      data: { userId: ctx.user.id, taxType: 'GST', jurisdiction: 'AU', rate: 0.1, currency: 'AUD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/tax-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('updates a tax rate', async () => {
    const config = await ctx.prisma.taxConfig.create({
      data: { userId: ctx.user.id, taxType: 'VAT', jurisdiction: 'DE', rate: 0.19, currency: 'EUR' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/tax-configs/${config.id}/rate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { rate: 0.16 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rate).toBe(0.16);
  });

  it('toggles a tax config', async () => {
    const config = await ctx.prisma.taxConfig.create({
      data: { userId: ctx.user.id, taxType: 'VAT', jurisdiction: 'FR', rate: 0.2, currency: 'EUR', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/tax-configs/${config.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('calculates tax', async () => {
    await ctx.prisma.taxConfig.create({
      data: { userId: ctx.user.id, taxType: 'VAT', jurisdiction: 'GB', rate: 0.2, currency: 'GBP', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/tax-configs/calculate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { taxType: 'VAT', jurisdiction: 'GB', amount: '100000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().taxApplied).toBe(true);
    expect(res.json().taxAmount).toBe('20000');
  });

  it('deletes a tax config', async () => {
    const config = await ctx.prisma.taxConfig.create({
      data: { userId: ctx.user.id, taxType: 'VAT', jurisdiction: 'ES', rate: 0.21, currency: 'EUR' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/tax-configs/${config.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data tax analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/tax-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConfigs).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
