import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class AccountTierService {
  constructor(private prisma: PrismaClient) {}

  async createTier(userId: string, data: {
    name: string;
    level: number;
    monthlyFee: bigint;
    currency: string;
    transactionLimit: bigint;
    description?: string;
  }) {
    const existing = await this.prisma.accountTier.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('tier_exists');

    return this.prisma.accountTier.create({
      data: {
        userId,
        name: data.name,
        level: data.level,
        monthlyFee: data.monthlyFee,
        currency: data.currency.toUpperCase(),
        transactionLimit: data.transactionLimit,
        description: data.description || null,
        subscriberCount: 0,
        isActive: true,
        reference: `ATR-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getTiers(userId: string) {
    return this.prisma.accountTier.findMany({ where: { userId } });
  }

  async getTier(userId: string, id: string) {
    const t = await this.prisma.accountTier.findUnique({ where: { id } });
    if (!t) throw new Error('tier_not_found');
    if ((t as any).userId !== userId) throw new Error('tier_not_found');
    return t;
  }

  async updateFee(userId: string, id: string, monthlyFee: bigint) {
    await this.getTier(userId, id);
    return this.prisma.accountTier.update({
      where: { id },
      data: { monthlyFee },
    });
  }

  async toggleTier(userId: string, id: string, active: boolean) {
    await this.getTier(userId, id);
    return this.prisma.accountTier.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteTier(userId: string, id: string) {
    await this.getTier(userId, id);
    return this.prisma.accountTier.delete({ where: { id } });
  }

  async getTierAnalytics(userId: string) {
    const tiers = await this.prisma.accountTier.findMany({ where: { userId } });

    if (tiers.length === 0) {
      return {
        totalTiers: 0,
        activeTiers: 0,
        totalSubscribers: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalSubscribers = 0;
    for (const t of tiers as any[]) {
      if (t.isActive) activeCount++;
      totalSubscribers += t.subscriberCount || 0;
    }

    return {
      totalTiers: tiers.length,
      activeTiers: activeCount,
      totalSubscribers,
      analyticsLevel: tiers.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
