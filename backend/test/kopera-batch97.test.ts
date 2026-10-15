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
    payload: { email: 'b97@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b97@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('budget categories', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a budget category', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/budget-categories/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Marketing', budgetLimit: '500000', currency: 'USD', period: 'MONTHLY' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Marketing');
    expect(res.json().budgetLimit).toBe('500000');
    expect(res.json().currentSpend).toBe('0');
  });

  it('rejects duplicate category name', async () => {
    await ctx.prisma.budgetCategory.create({
      data: { userId: ctx.user.id, name: 'Marketing', budgetLimit: BigInt(500000), currency: 'USD', period: 'MONTHLY' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/budget-categories/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Marketing', budgetLimit: '300000', currency: 'USD', period: 'WEEKLY' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('budget_category_exists');
  });

  it('lists budget categories', async () => {
    await ctx.prisma.budgetCategory.create({
      data: { userId: ctx.user.id, name: 'Travel', budgetLimit: BigInt(200000), currency: 'USD', period: 'MONTHLY' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/budget-categories/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('records spend on a category', async () => {
    const cat = await ctx.prisma.budgetCategory.create({
      data: { userId: ctx.user.id, name: 'Office', budgetLimit: BigInt(100000), currentSpend: BigInt(0), currency: 'USD', period: 'MONTHLY' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/budget-categories/${cat.id}/spend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount: '30000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentSpend).toBe('30000');
  });

  it('resets spend', async () => {
    const cat = await ctx.prisma.budgetCategory.create({
      data: { userId: ctx.user.id, name: 'Office', budgetLimit: BigInt(100000), currentSpend: BigInt(50000), currency: 'USD', period: 'MONTHLY' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/budget-categories/${cat.id}/reset`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentSpend).toBe('0');
  });

  it('updates budget limit', async () => {
    const cat = await ctx.prisma.budgetCategory.create({
      data: { userId: ctx.user.id, name: 'R&D', budgetLimit: BigInt(200000), currentSpend: BigInt(0), currency: 'USD', period: 'MONTHLY' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/budget-categories/${cat.id}/limit`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { budgetLimit: '400000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().budgetLimit).toBe('400000');
  });

  it('deletes a budget category', async () => {
    const cat = await ctx.prisma.budgetCategory.create({
      data: { userId: ctx.user.id, name: 'Temp', budgetLimit: BigInt(10000), currency: 'USD', period: 'WEEKLY' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/budget-categories/${cat.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data budget analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/budget-categories/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCategories).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payout methods', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('adds a payout method', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payout-methods/add',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { methodType: 'BANK_TRANSFER', provider: 'Chase', accountIdentifier: 'ACC-999', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().provider).toBe('CHASE');
    expect(res.json().isVerified).toBe(false);
  });

  it('rejects duplicate payout method', async () => {
    await ctx.prisma.payoutMethod.create({
      data: { userId: ctx.user.id, methodType: 'BANK_TRANSFER', provider: 'CHASE', accountIdentifier: 'ACC-999', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payout-methods/add',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { methodType: 'BANK_TRANSFER', provider: 'Chase', accountIdentifier: 'ACC-999', currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('payout_method_exists');
  });

  it('lists payout methods', async () => {
    await ctx.prisma.payoutMethod.create({
      data: { userId: ctx.user.id, methodType: 'PAYPAL', provider: 'PAYPAL', accountIdentifier: 'a@b.com', currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payout-methods/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('verifies a payout method', async () => {
    const m = await ctx.prisma.payoutMethod.create({
      data: { userId: ctx.user.id, methodType: 'BANK_TRANSFER', provider: 'BOA', accountIdentifier: 'ACC-1', currency: 'USD', isVerified: false },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payout-methods/${m.id}/verify`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isVerified).toBe(true);
  });

  it('sets a default payout method', async () => {
    const m = await ctx.prisma.payoutMethod.create({
      data: { userId: ctx.user.id, methodType: 'BANK_TRANSFER', provider: 'WF', accountIdentifier: 'ACC-2', currency: 'USD', isDefault: false },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payout-methods/${m.id}/set-default`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isDefault).toBe(true);
  });

  it('disables a payout method', async () => {
    const m = await ctx.prisma.payoutMethod.create({
      data: { userId: ctx.user.id, methodType: 'CRYPTO', provider: 'COINBASE', accountIdentifier: '0xabc', currency: 'USD', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payout-methods/${m.id}/disable`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DISABLED');
  });

  it('deletes a payout method', async () => {
    const m = await ctx.prisma.payoutMethod.create({
      data: { userId: ctx.user.id, methodType: 'PAYPAL', provider: 'PAYPAL', accountIdentifier: 'x@y.com', currency: 'EUR' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/payout-methods/${m.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data payout analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payout-methods/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalMethods).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('cashflow forecasts', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a cashflow forecast', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/cashflow-forecasts/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { period: 'MONTHLY', projectedInflow: '1000000', projectedOutflow: '700000', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().projectedInflow).toBe('1000000');
    expect(res.json().projectedOutflow).toBe('700000');
    expect(res.json().netFlow).toBe('300000');
    expect(res.json().confidence).toBe('POSITIVE');
  });

  it('lists cashflow forecasts', async () => {
    await ctx.prisma.cashflowForecast.create({
      data: { userId: ctx.user.id, period: 'MONTHLY', projectedInflow: BigInt(500000), projectedOutflow: BigInt(300000), netFlow: BigInt(200000), currency: 'USD', status: 'DRAFT' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cashflow-forecasts/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('finalizes a forecast', async () => {
    const fc = await ctx.prisma.cashflowForecast.create({
      data: { userId: ctx.user.id, period: 'QUARTERLY', projectedInflow: BigInt(2000000), projectedOutflow: BigInt(1500000), netFlow: BigInt(500000), currency: 'USD', status: 'DRAFT' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cashflow-forecasts/${fc.id}/finalize`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FINALIZED');
  });

  it('archives a forecast', async () => {
    const fc = await ctx.prisma.cashflowForecast.create({
      data: { userId: ctx.user.id, period: 'YEARLY', projectedInflow: BigInt(10000000), projectedOutflow: BigInt(8000000), netFlow: BigInt(2000000), currency: 'USD', status: 'FINALIZED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cashflow-forecasts/${fc.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARCHIVED');
  });

  it('gets forecasts by period', async () => {
    await ctx.prisma.cashflowForecast.create({
      data: { userId: ctx.user.id, period: 'WEEKLY', projectedInflow: BigInt(100000), projectedOutflow: BigInt(80000), netFlow: BigInt(20000), currency: 'USD', status: 'DRAFT' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cashflow-forecasts/period/WEEKLY',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('deletes a forecast', async () => {
    const fc = await ctx.prisma.cashflowForecast.create({
      data: { userId: ctx.user.id, period: 'MONTHLY', projectedInflow: BigInt(100000), projectedOutflow: BigInt(50000), netFlow: BigInt(50000), currency: 'EUR', status: 'DRAFT' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/cashflow-forecasts/${fc.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('creates negative confidence forecast', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/cashflow-forecasts/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { period: 'MONTHLY', projectedInflow: '200000', projectedOutflow: '500000', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().confidence).toBe('NEGATIVE');
    expect(res.json().netFlow).toBe('-300000');
  });

  it('returns no_data forecast analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cashflow-forecasts/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalForecasts).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
