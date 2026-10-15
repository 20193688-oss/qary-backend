import type { PrismaClient } from '@prisma/client';

export class PaymentChannelConfigService {
  constructor(private prisma: PrismaClient) {}

  async createConfig(userId: string, data: {
    channelName: string;
    channelType: string;
    supportedMethods: string;
    currency: string;
    feePercent: number;
  }) {
    return this.prisma.paymentChannelConfig.create({
      data: {
        userId,
        channelName: data.channelName,
        channelType: data.channelType.toUpperCase(),
        supportedMethods: data.supportedMethods.toUpperCase(),
        currency: data.currency.toUpperCase(),
        feePercent: data.feePercent,
        isActive: true,
        transactionCount: 0,
        totalVolume: BigInt(0),
      },
    });
  }

  async getConfigs(userId: string) {
    return this.prisma.paymentChannelConfig.findMany({ where: { userId } });
  }

  async getConfig(userId: string, id: string) {
    const c = await this.prisma.paymentChannelConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('channel_config_not_found');
    return c;
  }

  async recordTransaction(userId: string, id: string, amount: bigint) {
    const c = await this.prisma.paymentChannelConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('channel_config_not_found');
    if (!c.isActive) throw new Error('channel_not_active');
    return this.prisma.paymentChannelConfig.update({
      where: { id },
      data: {
        transactionCount: c.transactionCount + 1,
        totalVolume: (c.totalVolume ?? BigInt(0)) + amount,
      },
    });
  }

  async toggleConfig(userId: string, id: string, active: boolean) {
    const c = await this.prisma.paymentChannelConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('channel_config_not_found');
    return this.prisma.paymentChannelConfig.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteConfig(userId: string, id: string) {
    const c = await this.prisma.paymentChannelConfig.findFirst({ where: { id, userId } });
    if (!c) throw new Error('channel_config_not_found');
    return this.prisma.paymentChannelConfig.delete({ where: { id } });
  }

  async getChannelAnalytics(userId: string) {
    const all = await this.prisma.paymentChannelConfig.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalChannels: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((c) => c.isActive).length;
    let totalTx = 0;
    let totalVolume = BigInt(0);
    for (const c of all) {
      totalTx += c.transactionCount;
      totalVolume += c.totalVolume ?? BigInt(0);
    }
    const byType: Record<string, number> = {};
    for (const c of all) byType[c.channelType] = (byType[c.channelType] || 0) + 1;
    return {
      totalChannels: all.length,
      activeCount,
      totalTransactions: totalTx,
      totalVolume: totalVolume.toString(),
      byType,
      analyticsLevel: 'full' as const,
    };
  }
}
