import type { PrismaClient } from '@prisma/client';

export class TransactionService {
  constructor(private prisma: PrismaClient) {}

  async listTransactions(userId: string, filters?: {
    type?: string;
    status?: string;
    currency?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = { userId };
    if (filters?.type) where.type = filters.type;
    if (filters?.status) where.status = filters.status;
    if (filters?.currency) where.currency = filters.currency.toUpperCase();

    const rows = await this.prisma.transaction.findMany({ where });
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    return rows.slice(offset, offset + limit);
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
}
