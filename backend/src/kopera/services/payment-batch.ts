import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentBatchService {
  constructor(private prisma: PrismaClient) {}

  async createBatch(userId: string, data: {
    batchName: string;
    currency: string;
    description?: string;
    items: Array<{
      recipientName: string;
      recipientAccount: string;
      amount: bigint;
    }>;
  }) {
    const totalAmount = data.items.reduce((sum, item) => sum + item.amount, BigInt(0));

    const batch = await this.prisma.paymentBatch.create({
      data: {
        userId,
        batchName: data.batchName,
        currency: data.currency.toUpperCase(),
        description: data.description || null,
        itemCount: data.items.length,
        totalAmount,
        processedCount: 0,
        failedCount: 0,
        status: 'PENDING',
        reference: `PBT-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });

    for (const item of data.items) {
      await this.prisma.paymentBatchItem.create({
        data: {
          batchId: (batch as any).id,
          recipientName: item.recipientName,
          recipientAccount: item.recipientAccount,
          amount: item.amount,
          status: 'PENDING',
        },
      });
    }

    return batch;
  }

  async getBatches(userId: string) {
    return this.prisma.paymentBatch.findMany({ where: { userId } });
  }

  async getBatch(userId: string, id: string) {
    const batch = await this.prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch) throw new Error('batch_not_found');
    if ((batch as any).userId !== userId) throw new Error('batch_not_found');
    return batch;
  }

  async getBatchItems(userId: string, batchId: string) {
    await this.getBatch(userId, batchId);
    return this.prisma.paymentBatchItem.findMany({ where: { batchId } });
  }

  async processBatch(userId: string, id: string) {
    const batch = await this.getBatch(userId, id);
    if ((batch as any).status !== 'PENDING') throw new Error('batch_not_pending');

    const items = await this.prisma.paymentBatchItem.findMany({ where: { batchId: id } });
    let processed = 0;
    for (const item of items as any[]) {
      await this.prisma.paymentBatchItem.update({
        where: { id: item.id },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });
      processed++;
    }

    return this.prisma.paymentBatch.update({
      where: { id },
      data: { status: 'COMPLETED', processedCount: processed, completedAt: new Date() },
    });
  }

  async cancelBatch(userId: string, id: string) {
    const batch = await this.getBatch(userId, id);
    if ((batch as any).status !== 'PENDING') throw new Error('batch_not_pending');

    return this.prisma.paymentBatch.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getBatchAnalytics(userId: string) {
    const batches = await this.prisma.paymentBatch.findMany({ where: { userId } });

    if (batches.length === 0) {
      return {
        totalBatches: 0,
        breakdown: { PENDING: 0, COMPLETED: 0, CANCELLED: 0 },
        totalVolume: '0',
        totalItems: 0,
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, COMPLETED: 0, CANCELLED: 0 };
    let totalVolume = BigInt(0);
    let totalItems = 0;
    for (const b of batches as any[]) {
      const status = b.status as string;
      if (status in breakdown) breakdown[status]++;
      totalVolume += b.totalAmount as bigint;
      totalItems += b.itemCount || 0;
    }

    return {
      totalBatches: batches.length,
      breakdown,
      totalVolume: totalVolume.toString(),
      totalItems,
      analyticsLevel: batches.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
