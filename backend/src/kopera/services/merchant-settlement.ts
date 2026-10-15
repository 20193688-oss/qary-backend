import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class MerchantSettlementService {
  constructor(private prisma: PrismaClient) {}

  async createSettlement(userId: string, data: {
    merchantName: string;
    merchantId: string;
    amount: bigint;
    currency: string;
    settlementPeriod: string;
  }) {
    return this.prisma.merchantSettlement.create({
      data: {
        userId,
        merchantName: data.merchantName,
        merchantId: data.merchantId,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        settlementPeriod: data.settlementPeriod,
        fee: (data.amount * BigInt(15)) / BigInt(10000),
        netAmount: data.amount - (data.amount * BigInt(15)) / BigInt(10000),
        status: 'PENDING',
        reference: `MST-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getSettlements(userId: string) {
    return this.prisma.merchantSettlement.findMany({ where: { userId } });
  }

  async getSettlement(userId: string, id: string) {
    const s = await this.prisma.merchantSettlement.findUnique({ where: { id } });
    if (!s) throw new Error('settlement_not_found');
    if ((s as any).userId !== userId) throw new Error('settlement_not_found');
    return s;
  }

  async processSettlement(userId: string, id: string) {
    const s = await this.getSettlement(userId, id);
    if ((s as any).status !== 'PENDING') throw new Error('settlement_not_pending');

    return this.prisma.merchantSettlement.update({
      where: { id },
      data: { status: 'PROCESSING', processedAt: new Date() },
    });
  }

  async completeSettlement(userId: string, id: string) {
    const s = await this.getSettlement(userId, id);
    if ((s as any).status !== 'PROCESSING') throw new Error('settlement_not_processing');

    return this.prisma.merchantSettlement.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  }

  async cancelSettlement(userId: string, id: string) {
    const s = await this.getSettlement(userId, id);
    if ((s as any).status === 'COMPLETED') throw new Error('settlement_already_completed');
    if ((s as any).status === 'CANCELLED') throw new Error('settlement_already_cancelled');

    return this.prisma.merchantSettlement.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getSettlementAnalytics(userId: string) {
    const settlements = await this.prisma.merchantSettlement.findMany({ where: { userId } });

    if (settlements.length === 0) {
      return {
        totalSettlements: 0,
        breakdown: { PENDING: 0, PROCESSING: 0, COMPLETED: 0, CANCELLED: 0 },
        totalAmount: '0',
        totalFees: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, CANCELLED: 0 };
    let totalAmount = BigInt(0);
    let totalFees = BigInt(0);
    for (const s of settlements as any[]) {
      if (s.status in breakdown) breakdown[s.status]++;
      totalAmount += s.amount as bigint;
      totalFees += (s.fee || BigInt(0)) as bigint;
    }

    return {
      totalSettlements: settlements.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      totalFees: totalFees.toString(),
      analyticsLevel: settlements.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
