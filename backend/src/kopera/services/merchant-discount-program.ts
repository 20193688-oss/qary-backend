import type { PrismaClient } from '@prisma/client';

export class MerchantDiscountProgramService {
  constructor(private prisma: PrismaClient) {}

  async createProgram(userId: string, data: {
    name: string;
    discountType: string;
    discountValue: number;
    merchantId: string;
    startDate: string;
    endDate: string;
    maxRedemptions: number;
  }) {
    return this.prisma.merchantDiscountProgram.create({
      data: {
        userId,
        name: data.name,
        discountType: data.discountType.toUpperCase(),
        discountValue: data.discountValue,
        merchantId: data.merchantId,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        maxRedemptions: data.maxRedemptions,
        currentRedemptions: 0,
        totalSavings: BigInt(0),
        isActive: true,
      },
    });
  }

  async getPrograms(userId: string) {
    return this.prisma.merchantDiscountProgram.findMany({ where: { userId } });
  }

  async getProgram(userId: string, id: string) {
    const p = await this.prisma.merchantDiscountProgram.findFirst({ where: { id, userId } });
    if (!p) throw new Error('program_not_found');
    return p;
  }

  async redeemDiscount(userId: string, id: string, savedAmount: bigint) {
    const p = await this.prisma.merchantDiscountProgram.findFirst({ where: { id, userId } });
    if (!p) throw new Error('program_not_found');
    if (!p.isActive) throw new Error('program_not_active');
    if (p.currentRedemptions >= p.maxRedemptions) throw new Error('max_redemptions_reached');
    return this.prisma.merchantDiscountProgram.update({
      where: { id },
      data: {
        currentRedemptions: p.currentRedemptions + 1,
        totalSavings: (p.totalSavings ?? BigInt(0)) + savedAmount,
      },
    });
  }

  async toggleProgram(userId: string, id: string, active: boolean) {
    const p = await this.prisma.merchantDiscountProgram.findFirst({ where: { id, userId } });
    if (!p) throw new Error('program_not_found');
    return this.prisma.merchantDiscountProgram.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteProgram(userId: string, id: string) {
    const p = await this.prisma.merchantDiscountProgram.findFirst({ where: { id, userId } });
    if (!p) throw new Error('program_not_found');
    return this.prisma.merchantDiscountProgram.delete({ where: { id } });
  }

  async getProgramAnalytics(userId: string) {
    const all = await this.prisma.merchantDiscountProgram.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalPrograms: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((p) => p.isActive).length;
    let totalRedemptions = 0;
    let totalSavings = BigInt(0);
    for (const p of all) {
      totalRedemptions += p.currentRedemptions;
      totalSavings += p.totalSavings ?? BigInt(0);
    }
    return {
      totalPrograms: all.length,
      activeCount,
      totalRedemptions,
      totalSavings: totalSavings.toString(),
      analyticsLevel: 'full' as const,
    };
  }
}
