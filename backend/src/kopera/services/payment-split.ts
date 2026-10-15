import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentSplitService {
  constructor(private prisma: PrismaClient) {}

  async createSplit(userId: string, data: {
    description: string;
    totalAmount: bigint;
    currency: string;
    recipients: { name: string; accountId: string; share: number }[];
  }) {
    const totalShare = data.recipients.reduce((s, r) => s + r.share, 0);
    if (Math.abs(totalShare - 1) > 0.001) throw new Error('shares_must_equal_one');

    const split = await this.prisma.paymentSplit.create({
      data: {
        userId,
        description: data.description,
        totalAmount: data.totalAmount,
        currency: data.currency.toUpperCase(),
        recipientCount: data.recipients.length,
        status: 'PENDING',
        reference: `PSP-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });

    for (const r of data.recipients) {
      const amount = BigInt(Math.round(Number(data.totalAmount) * r.share));
      await this.prisma.paymentSplitRecipient.create({
        data: {
          splitId: split.id,
          name: r.name,
          accountId: r.accountId,
          share: r.share,
          amount,
          status: 'PENDING',
        },
      });
    }

    return split;
  }

  async getSplits(userId: string) {
    return this.prisma.paymentSplit.findMany({ where: { userId } });
  }

  async getSplit(userId: string, id: string) {
    const split = await this.prisma.paymentSplit.findUnique({ where: { id } });
    if (!split) throw new Error('split_not_found');
    if ((split as any).userId !== userId) throw new Error('split_not_found');
    return split;
  }

  async getSplitRecipients(userId: string, id: string) {
    await this.getSplit(userId, id);
    return this.prisma.paymentSplitRecipient.findMany({ where: { splitId: id } });
  }

  async executeSplit(userId: string, id: string) {
    const split = await this.getSplit(userId, id);
    if ((split as any).status !== 'PENDING') throw new Error('split_not_pending');

    const recipients = await this.prisma.paymentSplitRecipient.findMany({ where: { splitId: id } });
    for (const r of recipients) {
      await this.prisma.paymentSplitRecipient.update({
        where: { id: (r as any).id },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });
    }

    return this.prisma.paymentSplit.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  }

  async cancelSplit(userId: string, id: string) {
    const split = await this.getSplit(userId, id);
    if ((split as any).status !== 'PENDING') throw new Error('split_not_pending');

    return this.prisma.paymentSplit.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getSplitAnalytics(userId: string) {
    const splits = await this.prisma.paymentSplit.findMany({ where: { userId } });

    if (splits.length === 0) {
      return {
        totalSplits: 0,
        breakdown: { PENDING: 0, COMPLETED: 0, CANCELLED: 0 },
        totalAmount: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, COMPLETED: 0, CANCELLED: 0 };
    let totalAmount = BigInt(0);
    for (const s of splits as any[]) {
      const status = s.status as string;
      if (status in breakdown) breakdown[status]++;
      totalAmount += s.totalAmount as bigint;
    }

    return {
      totalSplits: splits.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      analyticsLevel: splits.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
