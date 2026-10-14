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
    payload: { email: 'b57@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b57@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('wallet balance growth trend', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no wallets', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/balance-growth-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(0);
    expect(body.overallTrend).toBe('none');
    expect(body.byWallet).toBeInstanceOf(Array);
  });

  it('tracks balance growth across wallets', async () => {
    const wallet = await ctx.prisma.wallet.create({
      data: { userId: ctx.user.id, currency: 'USD', isDefault: true },
    });
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, transactionId: 'txn1',
        amount: BigInt(50000), balanceBefore: BigInt(0), balanceAfter: BigInt(50000),
        entryType: 'CREDIT',
        createdAt: new Date(Date.now() - 10 * 86400000),
      },
    });
    await ctx.prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id, transactionId: 'txn2',
        amount: BigInt(30000), balanceBefore: BigInt(50000), balanceAfter: BigInt(80000),
        entryType: 'CREDIT',
        createdAt: new Date(Date.now() - 5 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/wallets/balance-growth-trend',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWallets).toBe(1);
    expect(body.byWallet.length).toBe(1);
    expect(body.byWallet[0].entries).toBe(2);
    expect(Number(body.byWallet[0].growthAmount)).toBeGreaterThan(0);
    expect(body.overallGrowthRate).toBeGreaterThan(0);
  });
});

describe('ant expenses seasonal pattern', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no expenses', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/seasonal-pattern',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(0);
    expect(body.pattern).toBe('none');
    expect(body.byMonth).toBeInstanceOf(Array);
  });

  it('detects seasonal patterns from expenses', async () => {
    const months = [0, 0, 0, 3, 3, 6, 6, 6, 6, 11];
    for (let i = 0; i < months.length; i++) {
      const d = new Date(2025, months[i], 15);
      await ctx.prisma.antExpense.create({
        data: {
          userId: ctx.user.id, merchantName: `Merchant${i}`,
          amount: BigInt(5000), currency: 'USD', frequency: 'monthly',
          category: 'entertainment',
          createdAt: d,
        },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ant-expenses/seasonal-pattern',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalExpenses).toBe(10);
    expect(body.byMonth.length).toBe(12);
    expect(body.peakMonth).toBeDefined();
    expect(body.seasonalityIndex).toBeGreaterThan(0);
  });
});

describe('bank accounts account aging', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no accounts', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/account-aging',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(0);
    expect(body.avgAgeDays).toBe(0);
  });

  it('analyzes account ages and staleness', async () => {
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, holderName: 'User1', bankName: 'Bank A',
        accountNumber: '1111', currency: 'USD', country: 'US', rail: 'ACH',
        createdAt: new Date(Date.now() - 400 * 86400000),
      },
    });
    await ctx.prisma.bankAccount.create({
      data: {
        userId: ctx.user.id, holderName: 'User1', bankName: 'Bank B',
        accountNumber: '2222', currency: 'EUR', country: 'DE', rail: 'SEPA',
        isVerified: true,
        createdAt: new Date(Date.now() - 30 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/bank-accounts/account-aging',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAccounts).toBe(2);
    expect(body.avgAgeDays).toBeGreaterThan(0);
    expect(body.oldestAgeDays).toBeGreaterThan(body.newestAgeDays);
    expect(body.byAgeGroup.length).toBe(4);
    expect(body.staleCount).toBe(1);
  });
});

describe('beneficiaries dormancy report', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns empty with no beneficiaries', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/dormancy-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(0);
    expect(body.dormant).toBeInstanceOf(Array);
  });

  it('identifies dormant beneficiaries', async () => {
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, nickname: 'Active Bob', currency: 'USD', accountIdentifier: 'acct1' },
    });
    await ctx.prisma.beneficiary.create({
      data: { userId: ctx.user.id, nickname: 'Dormant Jane', currency: 'EUR', accountIdentifier: 'acct2' },
    });
    await ctx.prisma.transaction.create({
      data: {
        userId: ctx.user.id, type: 'TRANSFER', amount: BigInt(10000),
        fee: BigInt(0), currency: 'USD', status: 'COMPLETED', reference: 'ref-dorm1',
        counterpartyName: 'Active Bob',
        processedAt: new Date(Date.now() - 10 * 86400000),
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/beneficiaries/dormancy-report',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalBeneficiaries).toBe(2);
    expect(body.activeCount).toBe(1);
    expect(body.dormantCount).toBe(1);
    expect(body.dormant.length).toBe(1);
    expect(body.dormant[0].nickname).toBe('Dormant Jane');
  });
});

describe('business profile compliance gap analysis', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('returns 404 with no profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/compliance-gap-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('identifies compliance gaps', async () => {
    await ctx.prisma.businessProfile.create({
      data: {
        userId: ctx.user.id, taxId: 'TAX123', taxIdType: 'RUC',
        taxIdCountry: 'PE', legalName: 'Test Corp', status: 'PENDING',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/business-profile/compliance-gap-analysis',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('PENDING');
    expect(body.totalGaps).toBeGreaterThan(0);
    expect(body.criticalGaps).toBeGreaterThan(0);
    expect(body.gaps).toBeInstanceOf(Array);
    expect(body.byCategory).toBeInstanceOf(Array);
    expect(body.complianceScore).toBeLessThan(100);
    expect(body.readiness).toBeDefined();
  });
});
