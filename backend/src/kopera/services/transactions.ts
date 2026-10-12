import type { PrismaClient } from '@prisma/client';

export class TransactionService {
  constructor(private prisma: PrismaClient) {}

  async listTransactions(userId: string, filters?: {
    type?: string;
    status?: string;
    currency?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = { userId };
    if (filters?.type) where.type = filters.type;
    if (filters?.status) where.status = filters.status;
    if (filters?.currency) where.currency = filters.currency.toUpperCase();

    const allRows = await this.prisma.transaction.findMany({ where });

    let filtered = allRows;
    if (filters?.from || filters?.to) {
      filtered = allRows.filter((t: any) => {
        const ts = new Date(t.createdAt).getTime();
        if (filters.from && ts < filters.from.getTime()) return false;
        if (filters.to && ts > filters.to.getTime()) return false;
        return true;
      });
    }

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async listByWallet(walletId: string, userId: string, limit = 50, offset = 0) {
    const all = await this.prisma.transaction.findMany({
      where: { userId },
    });
    const walletTxns = all.filter((t: any) =>
      t.senderWalletId === walletId || t.receiverWalletId === walletId,
    );
    return { rows: walletTxns.slice(offset, offset + limit), total: walletTxns.length };
  }

  async getTransaction(id: string, userId: string) {
    const txn = await this.prisma.transaction.findUnique({ where: { id } });
    if (!txn || txn.userId !== userId) return null;
    return txn;
  }

  async getByReference(reference: string, userId: string) {
    const txn = await this.prisma.transaction.findFirst({
      where: { reference, userId },
    });
    return txn;
  }

  async getSummary(userId: string, currency: string) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId, currency: currency.toUpperCase(), status: 'COMPLETED' },
    });

    let totalIn = BigInt(0);
    let totalOut = BigInt(0);
    let count = 0;

    for (const t of txns) {
      count++;
      if (t.type === 'DEPOSIT' || t.type === 'REWARD') {
        totalIn += t.amount;
      } else if (t.type === 'WITHDRAWAL' || t.type === 'PAYMENT' || t.type === 'FEE') {
        totalOut += t.amount;
      } else if (t.type === 'TRANSFER') {
        if (t.receiverWalletId && !t.senderWalletId) {
          totalIn += t.amount;
        } else {
          totalOut += t.amount;
        }
      }
    }

    return { currency: currency.toUpperCase(), totalIn, totalOut, count };
  }

  async getMonthlyBreakdown(userId: string, currency: string, year: number) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId, currency: currency.toUpperCase(), status: 'COMPLETED' },
    });

    const months: Array<{ month: number; totalIn: bigint; totalOut: bigint; transactionCount: number }> = [];
    for (let m = 1; m <= 12; m++) {
      months.push({ month: m, totalIn: BigInt(0), totalOut: BigInt(0), transactionCount: 0 });
    }

    for (const t of txns) {
      const d = new Date(t.createdAt);
      if (d.getFullYear() !== year) continue;
      const bucket = months[d.getMonth()];
      bucket.transactionCount++;
      if (t.type === 'DEPOSIT' || t.type === 'REWARD') {
        bucket.totalIn += t.amount;
      } else if (t.type === 'WITHDRAWAL' || t.type === 'PAYMENT' || t.type === 'FEE' || t.type === 'TRANSFER') {
        bucket.totalOut += t.amount;
      }
    }

    return months;
  }

  async getTypeDistribution(userId: string, currency?: string) {
    const where: Record<string, unknown> = { userId, status: 'COMPLETED' };
    if (currency) where.currency = currency.toUpperCase();
    const txns = await this.prisma.transaction.findMany({ where });

    const byType: Record<string, { count: number; totalAmount: bigint }> = {};
    for (const t of txns) {
      if (!byType[t.type]) byType[t.type] = { count: 0, totalAmount: BigInt(0) };
      byType[t.type].count++;
      byType[t.type].totalAmount += t.amount;
    }

    return { totalTransactions: txns.length, byType };
  }

  async searchTransactions(userId: string, query: string, opts?: { limit?: number }) {
    const all = await this.prisma.transaction.findMany({ where: { userId } });
    const q = query.toLowerCase();
    const matched = all.filter((t: any) =>
      (t.description && t.description.toLowerCase().includes(q)) ||
      (t.reference && t.reference.toLowerCase().includes(q)) ||
      (t.counterpartyName && t.counterpartyName.toLowerCase().includes(q))
    );
    const limit = Math.min(opts?.limit ?? 50, 100);
    return matched.slice(0, limit);
  }
}
