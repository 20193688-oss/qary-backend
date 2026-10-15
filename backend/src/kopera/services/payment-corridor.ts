import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentCorridorService {
  constructor(private prisma: PrismaClient) {}

  async createCorridor(userId: string, data: {
    sourceCurrency: string;
    targetCurrency: string;
    feePercentage: number;
    minAmount: bigint;
    maxAmount: bigint;
  }) {
    return this.prisma.paymentCorridor.create({
      data: {
        userId,
        sourceCurrency: data.sourceCurrency.toUpperCase(),
        targetCurrency: data.targetCurrency.toUpperCase(),
        feePercentage: data.feePercentage,
        minAmount: data.minAmount,
        maxAmount: data.maxAmount,
        transactionCount: 0,
        totalVolume: BigInt(0),
        isActive: true,
        reference: `COR-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getCorridors(userId: string) {
    return this.prisma.paymentCorridor.findMany({ where: { userId } });
  }

  async getCorridor(userId: string, id: string) {
    const c = await this.prisma.paymentCorridor.findUnique({ where: { id } });
    if (!c) throw new Error('corridor_not_found');
    if ((c as any).userId !== userId) throw new Error('corridor_not_found');
    return c;
  }

  async recordTransaction(userId: string, id: string, amount: bigint) {
    const c = await this.getCorridor(userId, id);
    if (!(c as any).isActive) throw new Error('corridor_not_active');

    return this.prisma.paymentCorridor.update({
      where: { id },
      data: {
        transactionCount: ((c as any).transactionCount || 0) + 1,
        totalVolume: ((c as any).totalVolume || BigInt(0)) + amount,
        lastUsedAt: new Date(),
      },
    });
  }

  async updateFee(userId: string, id: string, feePercentage: number) {
    await this.getCorridor(userId, id);
    return this.prisma.paymentCorridor.update({
      where: { id },
      data: { feePercentage },
    });
  }

  async toggleCorridor(userId: string, id: string, active: boolean) {
    await this.getCorridor(userId, id);
    return this.prisma.paymentCorridor.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteCorridor(userId: string, id: string) {
    await this.getCorridor(userId, id);
    return this.prisma.paymentCorridor.delete({ where: { id } });
  }

  async getCorridorAnalytics(userId: string) {
    const corridors = await this.prisma.paymentCorridor.findMany({ where: { userId } });

    if (corridors.length === 0) {
      return {
        totalCorridors: 0,
        activeCorridors: 0,
        totalVolume: '0',
        totalTransactions: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalVolume = BigInt(0);
    let totalTransactions = 0;
    for (const c of corridors as any[]) {
      if (c.isActive) activeCount++;
      totalVolume += (c.totalVolume || BigInt(0)) as bigint;
      totalTransactions += c.transactionCount || 0;
    }

    return {
      totalCorridors: corridors.length,
      activeCorridors: activeCount,
      totalVolume: totalVolume.toString(),
      totalTransactions,
      analyticsLevel: corridors.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
