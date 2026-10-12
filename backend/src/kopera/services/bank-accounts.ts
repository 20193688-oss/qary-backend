import type { PrismaClient, BankRail, Prisma } from '@prisma/client';

export class BankAccountService {
  constructor(private prisma: PrismaClient) {}

  async addAccount(userId: string, data: {
    bankName: string;
    bankCode?: string;
    accountNumber: string;
    accountType?: string;
    rail: BankRail;
    country: string;
    currency: string;
    holderName: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const existing = await this.prisma.bankAccount.findFirst({
      where: { userId, accountNumber: data.accountNumber, rail: data.rail as BankRail },
    });
    if (existing) throw new Error('account_already_exists');

    const hasAccounts = await this.prisma.bankAccount.count({ where: { userId } });
    return this.prisma.bankAccount.create({
      data: { userId, isDefault: hasAccounts === 0, ...data },
    });
  }

  async listAccounts(userId: string) {
    return this.prisma.bankAccount.findMany({ where: { userId } });
  }

  async getAccount(id: string) {
    return this.prisma.bankAccount.findUnique({ where: { id } });
  }

  async updateAccount(id: string, userId: string, data: {
    holderName?: string;
    bankName?: string;
    bankCode?: string;
    accountType?: string;
  }) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');

    return this.prisma.bankAccount.update({
      where: { id },
      data,
    });
  }

  async setDefault(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');

    await this.prisma.bankAccount.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
    return this.prisma.bankAccount.update({
      where: { id },
      data: { isDefault: true },
    });
  }

  async initiateVerification(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    if (acct.isVerified) throw new Error('already_verified');

    const amount1 = Math.floor(Math.random() * 99) + 1;
    const amount2 = Math.floor(Math.random() * 99) + 1;

    return this.prisma.bankAccount.update({
      where: { id },
      data: {
        metadata: {
          verificationStatus: 'pending',
          microDeposit1: amount1,
          microDeposit2: amount2,
          initiatedAt: new Date().toISOString(),
        },
      },
    });
  }

  async confirmVerification(id: string, userId: string, amount1: number, amount2: number) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    if (acct.isVerified) throw new Error('already_verified');

    const meta = acct.metadata as Record<string, unknown> | null;
    if (!meta || meta.verificationStatus !== 'pending') throw new Error('verification_not_initiated');

    const expected1 = meta.microDeposit1 as number;
    const expected2 = meta.microDeposit2 as number;

    if (amount1 !== expected1 || amount2 !== expected2) {
      throw new Error('amounts_mismatch');
    }

    return this.prisma.bankAccount.update({
      where: { id },
      data: {
        isVerified: true,
        metadata: { ...meta, verificationStatus: 'confirmed', confirmedAt: new Date().toISOString() },
      },
    });
  }

  async verify(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    if (acct.isVerified) throw new Error('already_verified');

    return this.prisma.bankAccount.update({
      where: { id },
      data: { isVerified: true },
    });
  }

  async getVerificationOverview(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });
    const byRail: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let verified = 0;
    let unverified = 0;

    for (const a of accounts) {
      byRail[a.rail] = (byRail[a.rail] ?? 0) + 1;
      byCountry[a.country] = (byCountry[a.country] ?? 0) + 1;
      if (a.isVerified) verified++;
      else unverified++;
    }

    return {
      totalAccounts: accounts.length,
      verified,
      unverified,
      verificationRate: accounts.length > 0 ? Math.round((verified / accounts.length) * 100) : 0,
      byRail,
      byCountry,
    };
  }

  async getPayoutReadiness(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    const readyAccounts: Array<{ id: string; bankName: string; rail: string; country: string; currency: string }> = [];
    const pendingAccounts: Array<{ id: string; bankName: string; reason: string }> = [];

    for (const a of accounts) {
      if (a.isVerified) {
        readyAccounts.push({ id: a.id, bankName: a.bankName, rail: a.rail, country: a.country, currency: a.currency });
      } else {
        pendingAccounts.push({ id: a.id, bankName: a.bankName, reason: 'not_verified' });
      }
    }

    const countryCoverage = [...new Set(readyAccounts.map((a) => a.country))];
    const railCoverage = [...new Set(readyAccounts.map((a) => a.rail))];

    return {
      totalAccounts: accounts.length,
      readyCount: readyAccounts.length,
      pendingCount: pendingAccounts.length,
      readyAccounts,
      pendingAccounts,
      countryCoverage,
      railCoverage,
    };
  }

  async getCoverageAnalysis(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    const byCountry: Record<string, { rails: string[]; currencies: string[]; verifiedCount: number; totalCount: number }> = {};
    const byRail: Record<string, { countries: string[]; count: number; verifiedCount: number }> = {};

    for (const a of accounts) {
      if (!byCountry[a.country]) byCountry[a.country] = { rails: [], currencies: [], verifiedCount: 0, totalCount: 0 };
      const countryEntry = byCountry[a.country];
      countryEntry.totalCount++;
      if (a.isVerified) countryEntry.verifiedCount++;
      if (!countryEntry.rails.includes(a.rail)) countryEntry.rails.push(a.rail);
      if (!countryEntry.currencies.includes(a.currency)) countryEntry.currencies.push(a.currency);

      if (!byRail[a.rail]) byRail[a.rail] = { countries: [], count: 0, verifiedCount: 0 };
      const railEntry = byRail[a.rail];
      railEntry.count++;
      if (a.isVerified) railEntry.verifiedCount++;
      if (!railEntry.countries.includes(a.country)) railEntry.countries.push(a.country);
    }

    const recommendations: string[] = [];
    const verifiedCount = accounts.filter((a: any) => a.isVerified).length;
    const unverifiedCount = accounts.length - verifiedCount;

    if (unverifiedCount > 0) recommendations.push(`${unverifiedCount} account(s) need verification`);
    if (Object.keys(byCountry).length === 1 && accounts.length > 0) recommendations.push('Consider adding accounts in other countries for broader coverage');
    if (Object.keys(byRail).length === 1 && accounts.length > 0) recommendations.push('Consider diversifying payment rails');

    const hasDefault = accounts.some((a: any) => a.isDefault);
    if (accounts.length > 0 && !hasDefault) recommendations.push('Set a default bank account');

    return {
      totalAccounts: accounts.length,
      verifiedCount,
      unverifiedCount,
      countryCoverage: Object.keys(byCountry).length,
      railCoverage: Object.keys(byRail).length,
      byCountry,
      byRail,
      recommendations,
    };
  }

  async removeAccount(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    return this.prisma.bankAccount.delete({ where: { id } });
  }
}
