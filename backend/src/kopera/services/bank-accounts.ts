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

  async removeAccount(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    return this.prisma.bankAccount.delete({ where: { id } });
  }
}
