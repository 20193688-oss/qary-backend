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
    payload: { email: 'b95@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b95@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('balance alerts', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a balance alert', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/balance-alerts/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { walletId: 'w-1', alertType: 'LOW_BALANCE', threshold: '50000', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().alertType).toBe('LOW_BALANCE');
    expect(res.json().threshold).toBe('50000');
  });

  it('lists alerts', async () => {
    await ctx.prisma.balanceAlert.create({
      data: { userId: ctx.user.id, walletId: 'w-1', alertType: 'LOW_BALANCE', threshold: BigInt(50000), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/balance-alerts/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('toggles an alert', async () => {
    const alert = await ctx.prisma.balanceAlert.create({
      data: { userId: ctx.user.id, walletId: 'w-1', alertType: 'LOW_BALANCE', threshold: BigInt(50000), currency: 'USD', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/balance-alerts/${alert.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('updates threshold', async () => {
    const alert = await ctx.prisma.balanceAlert.create({
      data: { userId: ctx.user.id, walletId: 'w-1', alertType: 'LOW_BALANCE', threshold: BigInt(50000), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/balance-alerts/${alert.id}/threshold`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { threshold: '100000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().threshold).toBe('100000');
  });

  it('records a trigger', async () => {
    const alert = await ctx.prisma.balanceAlert.create({
      data: { userId: ctx.user.id, walletId: 'w-1', alertType: 'LOW_BALANCE', threshold: BigInt(50000), currency: 'USD', triggerCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/balance-alerts/${alert.id}/trigger`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().triggerCount).toBe(1);
  });

  it('deletes an alert', async () => {
    const alert = await ctx.prisma.balanceAlert.create({
      data: { userId: ctx.user.id, walletId: 'w-1', alertType: 'LOW_BALANCE', threshold: BigInt(50000), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/balance-alerts/${alert.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data alert analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/balance-alerts/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalAlerts).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('payment batches', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a payment batch', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/payment-batches/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        batchName: 'Payroll Oct', currency: 'USD',
        items: [
          { recipientName: 'Alice', recipientAccount: 'ACC-1', amount: '100000' },
          { recipientName: 'Bob', recipientAccount: 'ACC-2', amount: '120000' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().batchName).toBe('Payroll Oct');
    expect(res.json().totalAmount).toBe('220000');
    expect(res.json().itemCount).toBe(2);
  });

  it('lists batches', async () => {
    await ctx.prisma.paymentBatch.create({
      data: { userId: ctx.user.id, batchName: 'Test', currency: 'USD', itemCount: 1, totalAmount: BigInt(10000), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-batches/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('processes a batch', async () => {
    const batch = await ctx.prisma.paymentBatch.create({
      data: { userId: ctx.user.id, batchName: 'Test', currency: 'USD', itemCount: 2, totalAmount: BigInt(200000), status: 'PENDING' },
    });
    await ctx.prisma.paymentBatchItem.create({
      data: { batchId: batch.id, recipientName: 'Alice', recipientAccount: 'ACC-1', amount: BigInt(100000), status: 'PENDING' },
    });
    await ctx.prisma.paymentBatchItem.create({
      data: { batchId: batch.id, recipientName: 'Bob', recipientAccount: 'ACC-2', amount: BigInt(100000), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-batches/${batch.id}/process`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('COMPLETED');
    expect(res.json().processedCount).toBe(2);
  });

  it('cancels a batch', async () => {
    const batch = await ctx.prisma.paymentBatch.create({
      data: { userId: ctx.user.id, batchName: 'Test', currency: 'USD', itemCount: 1, totalAmount: BigInt(10000), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/payment-batches/${batch.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('gets batch items', async () => {
    const batch = await ctx.prisma.paymentBatch.create({
      data: { userId: ctx.user.id, batchName: 'Test', currency: 'USD', itemCount: 1, totalAmount: BigInt(50000), status: 'PENDING' },
    });
    await ctx.prisma.paymentBatchItem.create({
      data: { batchId: batch.id, recipientName: 'Alice', recipientAccount: 'ACC-1', amount: BigInt(50000), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/payment-batches/${batch.id}/items`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
    expect(res.json()[0].amount).toBe('50000');
  });

  it('returns no_data batch analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/payment-batches/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalBatches).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single batch by id', async () => {
    const batch = await ctx.prisma.paymentBatch.create({
      data: { userId: ctx.user.id, batchName: 'Vendor Payments', currency: 'EUR', itemCount: 3, totalAmount: BigInt(500000), status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/payment-batches/${batch.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().batchName).toBe('Vendor Payments');
  });
});

describe('account groups', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an account group', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/account-groups/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Family Fund', groupType: 'FAMILY', description: 'Shared family account' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Family Fund');
    expect(res.json().groupType).toBe('FAMILY');
  });

  it('rejects duplicate group name', async () => {
    await ctx.prisma.accountGroup.create({
      data: { userId: ctx.user.id, name: 'Family Fund', groupType: 'FAMILY' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/account-groups/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { name: 'Family Fund', groupType: 'PERSONAL' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('group_name_exists');
  });

  it('lists groups', async () => {
    await ctx.prisma.accountGroup.create({
      data: { userId: ctx.user.id, name: 'Team', groupType: 'TEAM' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-groups/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('adds a member to a group', async () => {
    const group = await ctx.prisma.accountGroup.create({
      data: { userId: ctx.user.id, name: 'Team', groupType: 'TEAM', memberCount: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-groups/${group.id}/add-member`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { accountId: 'acc-123', role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('ADMIN');
  });

  it('rejects duplicate member', async () => {
    const group = await ctx.prisma.accountGroup.create({
      data: { userId: ctx.user.id, name: 'Team', groupType: 'TEAM', memberCount: 1 },
    });
    await ctx.prisma.accountGroupMember.create({
      data: { groupId: group.id, accountId: 'acc-123', role: 'MEMBER' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/account-groups/${group.id}/add-member`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { accountId: 'acc-123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('member_already_exists');
  });

  it('removes a member', async () => {
    const group = await ctx.prisma.accountGroup.create({
      data: { userId: ctx.user.id, name: 'Team', groupType: 'TEAM', memberCount: 1 },
    });
    const member = await ctx.prisma.accountGroupMember.create({
      data: { groupId: group.id, accountId: 'acc-123', role: 'MEMBER' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/account-groups/${group.id}/members/${member.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe(true);
  });

  it('lists members', async () => {
    const group = await ctx.prisma.accountGroup.create({
      data: { userId: ctx.user.id, name: 'Team', groupType: 'TEAM', memberCount: 1 },
    });
    await ctx.prisma.accountGroupMember.create({
      data: { groupId: group.id, accountId: 'acc-123', role: 'MEMBER' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/account-groups/${group.id}/members`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('deletes a group', async () => {
    const group = await ctx.prisma.accountGroup.create({
      data: { userId: ctx.user.id, name: 'Temp', groupType: 'PERSONAL' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/account-groups/${group.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data group analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/account-groups/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalGroups).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
