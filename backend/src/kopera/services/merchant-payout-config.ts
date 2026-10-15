import type { PrismaClient } from '@prisma/client';

export class MerchantPayoutConfigService {
  constructor(private prisma: PrismaClient) {}

  async createConfig(userId: string, data: {
    merchantId: string;
    frequency: string;
    minimumPayout: bigint;
    currency: string;
    bankAccountId: string;
  }) {
    return this.prisma.merchantPayoutConfig.create({
      data: {
        userId,
        merchantId: data.merchantId,
        frequency: data.frequency.toUpperCase(),
        minimumPayout: data.minimumPayout,
        currency: data.currency.toUpperCase(),
        bankAccountId: data.bankAccountId,
        isActive: true,
        totalPayouts: 0,
        totalPaidOut: BigInt(0),
        lastPayoutAt: null,
      },
    });
  }

  async getConfigs(userId: string) {
    return this.prisma.merchantPayoutConfig.findMany({ where: { userId } });
  }

  async getConfig(userId: string, id: string) {
    const c = await this.prisma.merchantPayoutConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('config_not_found');
    return c;
  }

  async recordPayout(userId: string, id: string, amount: bigint) {
    const c = await this.prisma.merchantPayoutConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('config_not_found');
    if (!c.isActive) throw new Error('config_not_active');
    return this.prisma.merchantPayoutConfig.update({
      where: { id },
      data: {
        totalPayouts: c.totalPayouts + 1,
        totalPaidOut: (c.totalPaidOut ?? BigInt(0)) + amount,
        lastPayoutAt: new Date(),
      },
    });
  }

  async toggleConfig(userId: string, id: string, active: boolean) {
    const c = await this.prisma.merchantPayoutConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('config_not_found');
    return this.prisma.merchantPayoutConfig.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteConfig(userId: string, id: string) {
    const c = await this.prisma.merchantPayoutConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('config_not_found');
    return this.prisma.merchantPayoutConfig.delete({ where: { id } });
  }

  async getConfigAnalytics(userId: string) {
    const all = await this.prisma.merchantPayoutConfig.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalConfigs: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((c) => c.isActive).length;
    let totalPayouts = 0;
    let totalPaidOut = BigInt(0);
    for (const c of all) {
      totalPayouts += c.totalPayouts;
      totalPaidOut += c.totalPaidOut ?? BigInt(0);
    }
    const byFrequency: Record<string, number> = {};
    for (const c of all) byFrequency[c.frequency] = (byFrequency[c.frequency] || 0) + 1;
    return {
      totalConfigs: all.length,
      activeCount,
      totalPayouts,
      totalPaidOut: totalPaidOut.toString(),
      byFrequency,
      analyticsLevel: 'full' as const,
    };
  }
}
