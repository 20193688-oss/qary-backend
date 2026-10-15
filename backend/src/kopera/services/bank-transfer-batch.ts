import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class BankTransferBatchService {
  constructor(private prisma: PrismaClient) {}

  async createBatch(userId: string, data: {
    name: string;
    currency: string;
    description?: string;
  }) {
    return this.prisma.bankTransferBatch.create({
      data: {
        userId,
        name: data.name,
        currency: data.currency.toUpperCase(),
        description: data.description || null,
        itemCount: 0,
        totalAmount: BigInt(0),
        processedCount: 0,
        failedCount: 0,
        status: 'DRAFT',
        reference: `BTB-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getBatches(userId: string) {
    return this.prisma.bankTransferBatch.findMany({ where: { userId } });
  }

  async getBatch(userId: string, id: string) {
    const b = await this.prisma.bankTransferBatch.findUnique({ where: { id } });
    if (!b) throw new Error('batch_not_found');
    if ((b as any).userId !== userId) throw new Error('batch_not_found');
    return b;
  }

  async submitBatch(userId: string, id: string) {
    const b = await this.getBatch(userId, id);
    if ((b as any).status !== 'DRAFT') throw new Error('batch_not_draft');
    if (((b as any).itemCount || 0) === 0) throw new Error('batch_empty');

    return this.prisma.bankTransferBatch.update({
      where: { id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
  }

  async processBatch(userId: string, id: string) {
    const b = await this.getBatch(userId, id);
    if ((b as any).status !== 'SUBMITTED') throw new Error('batch_not_submitted');

    return this.prisma.bankTransferBatch.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        processedCount: (b as any).itemCount || 0,
        completedAt: new Date(),
      },
    });
  }

  async cancelBatch(userId: string, id: string) {
    const b = await this.getBatch(userId, id);
    if ((b as any).status === 'COMPLETED') throw new Error('batch_already_completed');
    if ((b as any).status === 'CANCELLED') throw new Error('batch_already_cancelled');

    return this.prisma.bankTransferBatch.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async addItem(userId: string, batchId: string, data: {
    recipientName: string;
    recipientAccount: string;
    amount: bigint;
  }) {
    const b = await this.getBatch(userId, batchId);
    if ((b as any).status !== 'DRAFT') throw new Error('batch_not_draft');

    const item = await this.prisma.bankTransferBatchItem.create({
      data: {
        batchId,
        recipientName: data.recipientName,
        recipientAccount: data.recipientAccount,
        amount: data.amount,
        status: 'PENDING',
      },
    });

    await this.prisma.bankTransferBatch.update({
      where: { id: batchId },
      data: {
        itemCount: ((b as any).itemCount || 0) + 1,
        totalAmount: ((b as any).totalAmount || BigInt(0)) + data.amount,
      },
    });

    return item;
  }

  async getBatchAnalytics(userId: string) {
    const batches = await this.prisma.bankTransferBatch.findMany({ where: { userId } });

    if (batches.length === 0) {
      return {
        totalBatches: 0,
        breakdown: { DRAFT: 0, SUBMITTED: 0, COMPLETED: 0, CANCELLED: 0 },
        totalAmount: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { DRAFT: 0, SUBMITTED: 0, COMPLETED: 0, CANCELLED: 0 };
    let totalAmount = BigInt(0);
    for (const b of batches as any[]) {
      if (b.status in breakdown) breakdown[b.status]++;
      totalAmount += (b.totalAmount || BigInt(0)) as bigint;
    }

    return {
      totalBatches: batches.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      analyticsLevel: batches.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
