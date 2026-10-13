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
    payload: { email: 'b52@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b52@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('wallet currency diversification', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns none with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/currency-diversification',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(0);
    expect(body.hhi).toBe(0);
    expect(body.concentrationLevel).toBe('none');
  });

  it('calculates HHI across multiple currencies', async () => {
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(50000), status: 'ACTIVE', isDefault: true },
    });
    await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'EUR', balance: BigInt(50000), status: 'ACTIVE', isDefault: false },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/currency-diversification',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(2);
    expect(body.currencies).toHaveLength(2);
    expect(body.hhi).toBeLessThanOrEqual(5000);
    expect(body.concentrationLevel).toBe('moderate');
    expect(body.currencies[0].share).toBeCloseTo(50, 0);
  });
});

describe('ant-expenses category risk score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns none with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/category-risk-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveExpenses).toBe(0);
    expect(body.overallRiskScore).toBe(0);
    expect(body.riskLevel).toBe('none');
    expect(body.byCategory).toBeInstanceOf(Array);
  });

  it('scores categories by concentration and diversity', async () => {
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id, merchantName: 'Netflix', category: 'entertainment',
        amount: BigInt(1500), currency: 'USD', frequency: 'monthly', isActive: true,
      },
    });
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id, merchantName: 'Spotify', category: 'entertainment',
        amount: BigInt(1000), currency: 'USD', frequency: 'monthly', isActive: true,
      },
    });
    await ctx.prisma.antExpense.create({
      data: {
        userId: ctx.user.id, merchantName: 'AWS', category: 'software',
        amount: BigInt(5000), currency: 'USD', frequency: 'monthly', isActive: true,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/category-risk-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalActiveExpenses).toBe(3);
    expect(body.byCategory.length).toBe(2);
    expect(body.overallRiskScore).toBeGreaterThan(0);
    expect(['high', 'medium', 'low']).toContain(body.riskLevel);
    const software = body.byCategory.find((c: any) => c.category === 'software');
    expect(software).toBeDefined();
    expect(software.merchantCount).toBe(1);
  });
});

describe('bank-accounts redundancy analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/redundancy-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.redundantGroups).toBeInstanceOf(Array);
    expect(body.redundantCount).toBe(0);
  });

  it('detects redundant accounts at same bank and currency', async () => {
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, bankName: 'Chase', currency: 'USD',
        accountNumber: '1111', holderName: 'User A', country: 'US',
        isDefault: true, verified: true,
      },
    });
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, bankName: 'Chase', currency: 'USD',
        accountNumber: '2222', holderName: 'User A', country: 'US',
        isDefault: false, verified: true,
      },
    });
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, bankName: 'BoA', currency: 'USD',
        accountNumber: '3333', holderName: 'User A', country: 'US',
        isDefault: false, verified: false,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/redundancy-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(3);
    expect(body.redundantGroups.length).toBe(1);
    expect(body.redundantGroups[0].bankName).toBe('Chase');
    expect(body.redundantGroups[0].count).toBe(2);
    expect(body.redundantCount).toBe(1);
    expect(body.uniqueCount).toBe(2);
  });
});

describe('beneficiaries activity score', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/activity-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.avgScore).toBe(0);
    expect(body.scores).toBeInstanceOf(Array);
  });

  it('scores beneficiaries by transaction engagement', async () => {
    const b1 = await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, nickname: 'Alice', accountIdentifier: 'acc1' },
    });
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, nickname: 'Bob', accountIdentifier: 'acc2' },
    });

    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(100000), status: 'ACTIVE', isDefault: true },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'TRANSFER',
        amount: BigInt(5000), currency: 'USD', status: 'COMPLETED',
        counterpartyName: 'Alice', description: 'Payment to Alice',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/activity-score',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(2);
    expect(body.scores).toHaveLength(2);
    const alice = body.scores.find((s: any) => s.nickname === 'Alice');
    const bob = body.scores.find((s: any) => s.nickname === 'Bob');
    expect(alice.transactionCount).toBe(1);
    expect(alice.activityScore).toBeGreaterThan(bob.activityScore);
  });
});

describe('disputes outcome analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns zeros with no disputes', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/outcome-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(0);
    expect(body.resolved).toBe(0);
    expect(body.pending).toBe(0);
    expect(body.winRate).toBe(0);
    expect(body.byReason).toBeInstanceOf(Array);
    expect(body.byCurrency).toBeInstanceOf(Array);
  });

  it('analyzes outcomes by reason and currency', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', balance: BigInt(100000), status: 'ACTIVE', isDefault: true },
    });
    const tx = await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, walletId: wallet.id, type: 'PAYMENT',
        amount: BigInt(5000), currency: 'USD', status: 'COMPLETED', description: 'test',
      },
    });

    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: tx.id, reason: 'unauthorized',
        amount: BigInt(5000), currency: 'USD', status: 'WON',
        outcome: 'Refunded', resolvedAt: new Date(),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: tx.id, reason: 'unauthorized',
        amount: BigInt(3000), currency: 'USD', status: 'LOST',
        outcome: 'Denied', resolvedAt: new Date(),
      },
    });
    await ctx.prisma.dispute.create({
      data: {
        userId: ctx.user.id, transactionId: tx.id, reason: 'duplicate',
        amount: BigInt(2000), currency: 'EUR', status: 'OPEN',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/disputes/outcome-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDisputes).toBe(3);
    expect(body.resolved).toBe(2);
    expect(body.pending).toBe(1);
    expect(body.winRate).toBe(50);
    expect(body.byReason.length).toBe(2);
    const unauthorized = body.byReason.find((r: any) => r.reason === 'unauthorized');
    expect(unauthorized.total).toBe(2);
    expect(unauthorized.won).toBe(1);
    expect(body.byCurrency.length).toBe(2);
  });
});
