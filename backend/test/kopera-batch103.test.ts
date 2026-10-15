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
    payload: { email: 'b103@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b103@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('invoice reminders', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a reminder', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/invoice-reminders/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { invoiceId: 'inv-1', recipientEmail: 'client@example.com', message: 'Please pay', sendAt: '2026-11-01T09:00:00Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().invoiceId).toBe('inv-1');
    expect(res.json().status).toBe('SCHEDULED');
  });

  it('lists reminders', async () => {
    await ctx.prisma.invoiceReminder.create({
      data: { userId: ctx.user.id, invoiceId: 'inv-2', recipientEmail: 'a@b.com', message: 'Pay now', sendAt: new Date(), status: 'SCHEDULED' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoice-reminders/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('sends a reminder', async () => {
    const r = await ctx.prisma.invoiceReminder.create({
      data: { userId: ctx.user.id, invoiceId: 'inv-3', recipientEmail: 'c@d.com', message: 'Overdue', sendAt: new Date(), status: 'SCHEDULED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoice-reminders/${r.id}/send`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SENT');
  });

  it('cancels a reminder', async () => {
    const r = await ctx.prisma.invoiceReminder.create({
      data: { userId: ctx.user.id, invoiceId: 'inv-4', recipientEmail: 'e@f.com', message: 'Reminder', sendAt: new Date(), status: 'SCHEDULED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/invoice-reminders/${r.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data reminder analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/invoice-reminders/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalReminders).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('transaction tags', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a tag', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-tags/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Food', color: '#FF5733' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Food');
    expect(res.json().color).toBe('#FF5733');
    expect(res.json().isActive).toBe(true);
  });

  it('rejects duplicate tag name', async () => {
    await ctx.prisma.transactionTag.create({
      data: { userId: ctx.user.id, name: 'Travel', color: '#00FF00' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/transaction-tags/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Travel', color: '#0000FF' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('lists tags', async () => {
    await ctx.prisma.transactionTag.create({
      data: { userId: ctx.user.id, name: 'Bills', color: '#AABBCC' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-tags/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('applies a tag', async () => {
    const t = await ctx.prisma.transactionTag.create({
      data: { userId: ctx.user.id, name: 'Groceries', color: '#112233', isActive: true, usageCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-tags/${t.id}/apply`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().usageCount).toBe(1);
  });

  it('toggles a tag off', async () => {
    const t = await ctx.prisma.transactionTag.create({
      data: { userId: ctx.user.id, name: 'Off', color: '#000000', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/transaction-tags/${t.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('deletes a tag', async () => {
    const t = await ctx.prisma.transactionTag.create({
      data: { userId: ctx.user.id, name: 'Remove', color: '#FFFFFF' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/transaction-tags/${t.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data tag analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/transaction-tags/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTags).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('recurring payments', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a recurring payment', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/recurring-payments/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { recipientName: 'Landlord', recipientAccount: 'ACC-L', amount: '150000', currency: 'USD', frequency: 'MONTHLY' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipientName).toBe('Landlord');
    expect(res.json().amount).toBe('150000');
    expect(res.json().status).toBe('ACTIVE');
    expect(res.json().totalPaid).toBe('0');
  });

  it('lists recurring payments', async () => {
    await ctx.prisma.recurringPayment.create({
      data: { userId: ctx.user.id, recipientName: 'ISP', recipientAccount: 'ACC-I', amount: BigInt(5000), currency: 'USD', frequency: 'MONTHLY' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/recurring-payments/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('executes a payment', async () => {
    const r = await ctx.prisma.recurringPayment.create({
      data: { userId: ctx.user.id, recipientName: 'Gym', recipientAccount: 'ACC-G', amount: BigInt(3000), currency: 'USD', frequency: 'MONTHLY', status: 'ACTIVE', executionCount: 0, totalPaid: BigInt(0) },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-payments/${r.id}/execute`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().executionCount).toBe(1);
    expect(res.json().totalPaid).toBe('3000');
  });

  it('pauses a payment', async () => {
    const r = await ctx.prisma.recurringPayment.create({
      data: { userId: ctx.user.id, recipientName: 'Sub', recipientAccount: 'ACC-S', amount: BigInt(999), currency: 'USD', frequency: 'MONTHLY', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-payments/${r.id}/pause`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAUSED');
  });

  it('resumes a payment', async () => {
    const r = await ctx.prisma.recurringPayment.create({
      data: { userId: ctx.user.id, recipientName: 'Util', recipientAccount: 'ACC-U', amount: BigInt(8000), currency: 'USD', frequency: 'MONTHLY', status: 'PAUSED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-payments/${r.id}/resume`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('cancels a payment', async () => {
    const r = await ctx.prisma.recurringPayment.create({
      data: { userId: ctx.user.id, recipientName: 'Cancel', recipientAccount: 'ACC-C', amount: BigInt(1000), currency: 'EUR', frequency: 'WEEKLY', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/recurring-payments/${r.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data recurring analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/recurring-payments/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRecurrings).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
