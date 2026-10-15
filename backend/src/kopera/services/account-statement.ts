import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class AccountStatementService {
  constructor(private prisma: PrismaClient) {}

  async generateStatement(userId: string, data: {
    walletId: string;
    periodStart: Date;
    periodEnd: Date;
    format?: string;
  }) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: data.walletId } });
    if (!wallet) throw new Error('wallet_not_found');
    if ((wallet as any).userId !== userId) throw new Error('wallet_not_found');

    const transactions = await this.prisma.transaction.findMany({ where: { userId } });
    const filtered = (transactions as any[]).filter((t) => {
      const d = new Date(t.createdAt);
      return d >= data.periodStart && d <= data.periodEnd;
    });

    const totalCredits = filtered
      .filter((t: any) => t.type === 'CREDIT' || t.type === 'DEPOSIT')
      .reduce((s: bigint, t: any) => s + ((t.amount as bigint) || BigInt(0)), BigInt(0));

    const totalDebits = filtered
      .filter((t: any) => t.type === 'DEBIT' || t.type === 'WITHDRAWAL')
      .reduce((s: bigint, t: any) => s + ((t.amount as bigint) || BigInt(0)), BigInt(0));

    return this.prisma.accountStatement.create({
      data: {
        userId,
        walletId: data.walletId,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        format: data.format || 'JSON',
        currency: (wallet as any).currency,
        openingBalance: (wallet as any).balance,
        closingBalance: (wallet as any).balance,
        totalCredits,
        totalDebits,
        transactionCount: filtered.length,
        status: 'GENERATED',
        reference: `STM-${Date.now()}-${randomUUID().slice(0, 8)}`,
        generatedAt: new Date(),
      },
    });
  }

  async getStatements(userId: string) {
    return this.prisma.accountStatement.findMany({ where: { userId } });
  }

  async getStatement(userId: string, id: string) {
    const statement = await this.prisma.accountStatement.findUnique({ where: { id } });
    if (!statement) throw new Error('statement_not_found');
    if ((statement as any).userId !== userId) throw new Error('statement_not_found');
    return statement;
  }

  async downloadStatement(userId: string, id: string) {
    const statement = await this.getStatement(userId, id);
    await this.prisma.accountStatement.update({
      where: { id },
      data: { downloadCount: ((statement as any).downloadCount || 0) + 1, lastDownloadedAt: new Date() },
    });
    return statement;
  }

  async getStatementAnalytics(userId: string) {
    const statements = await this.prisma.accountStatement.findMany({ where: { userId } });

    if (statements.length === 0) {
      return {
        totalStatements: 0,
        breakdown: { generated: 0, downloaded: 0 },
        totalCredits: '0',
        totalDebits: '0',
        analyticsLevel: 'no_data',
      };
    }

    let totalCredits = BigInt(0);
    let totalDebits = BigInt(0);
    let downloadedCount = 0;

    for (const s of statements as any[]) {
      totalCredits += (s.totalCredits as bigint) || BigInt(0);
      totalDebits += (s.totalDebits as bigint) || BigInt(0);
      if (s.downloadCount > 0) downloadedCount++;
    }

    return {
      totalStatements: statements.length,
      breakdown: {
        generated: statements.length,
        downloaded: downloadedCount,
      },
      totalCredits: totalCredits.toString(),
      totalDebits: totalDebits.toString(),
      analyticsLevel: statements.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
