import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class FeeScheduleService {
  constructor(private prisma: PrismaClient) {}

  async createFee(userId: string, data: {
    transactionType: string;
    feeType: string;
    fixedAmount?: bigint;
    percentageRate?: number;
    currency: string;
    minAmount?: bigint;
    maxAmount?: bigint;
  }) {
    const existing = await this.prisma.feeSchedule.findFirst({
      where: { userId, transactionType: data.transactionType, currency: data.currency.toUpperCase() },
    });
    if (existing) throw new Error('fee_already_exists');

    return this.prisma.feeSchedule.create({
      data: {
        userId,
        transactionType: data.transactionType,
        feeType: data.feeType,
        fixedAmount: data.fixedAmount || BigInt(0),
        percentageRate: data.percentageRate || 0,
        currency: data.currency.toUpperCase(),
        minAmount: data.minAmount || null,
        maxAmount: data.maxAmount || null,
        isActive: true,
        reference: `FEE-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getFees(userId: string) {
    return this.prisma.feeSchedule.findMany({ where: { userId } });
  }

  async getFee(userId: string, id: string) {
    const fee = await this.prisma.feeSchedule.findUnique({ where: { id } });
    if (!fee) throw new Error('fee_not_found');
    if ((fee as any).userId !== userId) throw new Error('fee_not_found');
    return fee;
  }

  async updateFee(userId: string, id: string, data: {
    fixedAmount?: bigint;
    percentageRate?: number;
    minAmount?: bigint;
    maxAmount?: bigint;
  }) {
    await this.getFee(userId, id);
    const updateData: Record<string, unknown> = {};
    if (data.fixedAmount !== undefined) updateData.fixedAmount = data.fixedAmount;
    if (data.percentageRate !== undefined) updateData.percentageRate = data.percentageRate;
    if (data.minAmount !== undefined) updateData.minAmount = data.minAmount;
    if (data.maxAmount !== undefined) updateData.maxAmount = data.maxAmount;

    return this.prisma.feeSchedule.update({ where: { id }, data: updateData });
  }

  async calculateFee(userId: string, transactionType: string, amount: bigint, currency: string) {
    const fees = await this.prisma.feeSchedule.findMany({ where: { userId } });
    const fee = (fees as any[]).find(
      (f) => f.transactionType === transactionType && f.currency === currency.toUpperCase() && f.isActive,
    );

    if (!fee) return { feeAmount: BigInt(0), feeApplied: false };

    let feeAmount: bigint;
    if (fee.feeType === 'FIXED') {
      feeAmount = fee.fixedAmount as bigint;
    } else if (fee.feeType === 'PERCENTAGE') {
      feeAmount = BigInt(Math.round(Number(amount) * (fee.percentageRate as number)));
    } else {
      const fixed = fee.fixedAmount as bigint;
      const pct = BigInt(Math.round(Number(amount) * (fee.percentageRate as number)));
      feeAmount = fixed + pct;
    }

    if (fee.minAmount && feeAmount < (fee.minAmount as bigint)) feeAmount = fee.minAmount as bigint;
    if (fee.maxAmount && feeAmount > (fee.maxAmount as bigint)) feeAmount = fee.maxAmount as bigint;

    return { feeAmount, feeApplied: true, feeType: fee.feeType };
  }

  async removeFee(userId: string, id: string) {
    await this.getFee(userId, id);
    return this.prisma.feeSchedule.delete({ where: { id } });
  }

  async getFeeAnalytics(userId: string) {
    const fees = await this.prisma.feeSchedule.findMany({ where: { userId } });

    if (fees.length === 0) {
      return {
        totalFees: 0,
        activeFees: 0,
        feeTypes: {},
        transactionTypes: [],
        analyticsLevel: 'no_data',
      };
    }

    const active = (fees as any[]).filter((f) => f.isActive).length;
    const feeTypes: Record<string, number> = {};
    const transactionTypes = new Set<string>();
    for (const f of fees as any[]) {
      feeTypes[f.feeType] = (feeTypes[f.feeType] || 0) + 1;
      transactionTypes.add(f.transactionType);
    }

    return {
      totalFees: fees.length,
      activeFees: active,
      feeTypes,
      transactionTypes: [...transactionTypes],
      analyticsLevel: active > 0 ? 'configured' : 'inactive',
    };
  }
}
