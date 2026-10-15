import type { PrismaClient } from '@prisma/client';

export class MerchantFeeOverrideService {
  constructor(private prisma: PrismaClient) {}

  async createOverride(userId: string, data: {
    merchantId: string;
    feeType: string;
    feePercent: number;
    flatFee: bigint;
    currency: string;
    effectiveFrom: string;
  }) {
    return this.prisma.merchantFeeOverride.create({
      data: {
        userId,
        merchantId: data.merchantId,
        feeType: data.feeType.toUpperCase(),
        feePercent: data.feePercent,
        flatFee: data.flatFee,
        currency: data.currency.toUpperCase(),
        effectiveFrom: new Date(data.effectiveFrom),
        isActive: true,
        appliedCount: 0,
        totalFeeCollected: BigInt(0),
      },
    });
  }

  async getOverrides(userId: string) {
    return this.prisma.merchantFeeOverride.findMany({ where: { userId } });
  }

  async getOverride(userId: string, id: string) {
    const o = await this.prisma.merchantFeeOverride.findFirst({ where: { id, userId } });
    if (!o) throw new Error('override_not_found');
    return o;
  }

  async applyFee(userId: string, id: string, amount: bigint) {
    const o = await this.prisma.merchantFeeOverride.findFirst({ where: { id, userId } });
    if (!o) throw new Error('override_not_found');
    if (!o.isActive) throw new Error('override_not_active');
    return this.prisma.merchantFeeOverride.update({
      where: { id },
      data: {
        appliedCount: o.appliedCount + 1,
        totalFeeCollected: (o.totalFeeCollected ?? BigInt(0)) + amount,
      },
    });
  }

  async toggleOverride(userId: string, id: string, active: boolean) {
    const o = await this.prisma.merchantFeeOverride.findFirst({ where: { id, userId } });
    if (!o) throw new Error('override_not_found');
    return this.prisma.merchantFeeOverride.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteOverride(userId: string, id: string) {
    const o = await this.prisma.merchantFeeOverride.findFirst({ where: { id, userId } });
    if (!o) throw new Error('override_not_found');
    return this.prisma.merchantFeeOverride.delete({ where: { id } });
  }

  async getOverrideAnalytics(userId: string) {
    const all = await this.prisma.merchantFeeOverride.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalOverrides: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((o) => o.isActive).length;
    let totalCollected = BigInt(0);
    for (const o of all) totalCollected += o.totalFeeCollected ?? BigInt(0);
    const byType: Record<string, number> = {};
    for (const o of all) byType[o.feeType] = (byType[o.feeType] || 0) + 1;
    return {
      totalOverrides: all.length,
      activeCount,
      totalFeeCollected: totalCollected.toString(),
      byType,
      analyticsLevel: 'full' as const,
    };
  }
}
