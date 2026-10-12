import type { PrismaClient } from '@prisma/client';

export class LedgerService {
  constructor(private prisma: PrismaClient) {}

  async listByWallet(walletId: string, filters?: {
    entryType?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = { walletId };
    if (filters?.entryType) where.entryType = filters.entryType;

    return this.prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filters?.limit ?? 50,
      skip: filters?.offset ?? 0,
    });
  }

  async getById(id: string) {
    return this.prisma.ledgerEntry.findUnique({ where: { id } });
  }

  async listByTransaction(transactionId: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { transactionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getBalanceSummary(userId: string) {
    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    return wallets.map((w: any) => ({
      walletId: w.id,
      currency: w.currency,
      balance: w.balance,
      availableBalance: w.availableBalance ?? w.balance,
      holdBalance: w.holdBalance ?? BigInt(0),
      status: w.status,
    }));
  }

  async getFlowAnalysis(walletId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    let totalCredits = BigInt(0);
    let totalDebits = BigInt(0);
    let peakBalance = BigInt(0);
    let lowestBalance = BigInt(0);
    let largestCredit = BigInt(0);
    let largestDebit = BigInt(0);
    let isFirst = true;

    for (const e of entries) {
      if (e.entryType === 'CREDIT') {
        totalCredits += e.amount;
        if (e.amount > largestCredit) largestCredit = e.amount;
      } else {
        totalDebits += e.amount;
        const absAmount = e.amount < BigInt(0) ? -e.amount : e.amount;
        if (absAmount > largestDebit) largestDebit = absAmount;
      }
      if (isFirst || e.balanceAfter > peakBalance) peakBalance = e.balanceAfter;
      if (isFirst || e.balanceAfter < lowestBalance) lowestBalance = e.balanceAfter;
      isFirst = false;
    }

    return {
      walletId,
      entryCount: entries.length,
      totalCredits,
      totalDebits,
      netFlow: totalCredits + totalDebits,
      peakBalance,
      lowestBalance,
      largestCredit,
      largestDebit,
    };
  }

  async getReconciliationReport(walletId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new Error('wallet_not_found');

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    let computedBalance = BigInt(0);
    const mismatches: Array<{ entryId: string; expected: bigint; recorded: bigint; entryType: string }> = [];
    let creditCount = 0;
    let debitCount = 0;

    for (const e of entries) {
      if (e.balanceBefore !== computedBalance) {
        mismatches.push({ entryId: e.id, expected: computedBalance, recorded: e.balanceBefore, entryType: e.entryType });
      }
      computedBalance = e.balanceAfter;
      if (e.entryType === 'CREDIT') creditCount++;
      else debitCount++;
    }

    const balanceMatchesLedger = computedBalance === wallet.balance;

    return {
      walletId,
      currency: wallet.currency,
      walletBalance: wallet.balance,
      computedBalance,
      balanceMatchesLedger,
      totalEntries: entries.length,
      creditCount,
      debitCount,
      mismatches,
      status: mismatches.length === 0 && balanceMatchesLedger ? 'clean' : 'discrepancies_found',
    };
  }

  async getStatement(walletId: string, from: string, to: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        walletId,
        createdAt: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: { createdAt: 'asc' },
    });

    let totalDebits = BigInt(0);
    let totalCredits = BigInt(0);
    for (const e of entries) {
      if (e.entryType === 'DEBIT') totalDebits += e.amount;
      else totalCredits += e.amount;
    }

    const first = entries[0];
    const last = entries[entries.length - 1];

    return {
      walletId,
      from,
      to,
      entries,
      totalDebits,
      totalCredits,
      entryCount: entries.length,
      openingBalance: first ? first.balanceBefore : BigInt(0),
      closingBalance: last ? last.balanceAfter : BigInt(0),
    };
  }
}
