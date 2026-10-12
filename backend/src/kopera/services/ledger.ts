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
