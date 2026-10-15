import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentMethodConfigService {
  constructor(private prisma: PrismaClient) {}

  async createConfig(userId: string, data: {
    methodType: string;
    provider: string;
    currency: string;
    minAmount: bigint;
    maxAmount: bigint;
  }) {
    return this.prisma.paymentMethodConfig.create({
      data: {
        userId,
        methodType: data.methodType.toUpperCase(),
        provider: data.provider,
        currency: data.currency.toUpperCase(),
        minAmount: data.minAmount,
        maxAmount: data.maxAmount,
        transactionCount: 0,
        isActive: true,
        reference: `PMC-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getConfigs(userId: string) {
    return this.prisma.paymentMethodConfig.findMany({ where: { userId } });
  }

  async getConfig(userId: string, id: string) {
    const c = await this.prisma.paymentMethodConfig.findUnique({ where: { id } });
    if (!c) throw new Error('config_not_found');
    if ((c as any).userId !== userId) throw new Error('config_not_found');
    return c;
  }

  async updateLimits(userId: string, id: string, minAmount: bigint, maxAmount: bigint) {
    await this.getConfig(userId, id);
    return this.prisma.paymentMethodConfig.update({
      where: { id },
      data: { minAmount, maxAmount },
    });
  }

  async toggleConfig(userId: string, id: string, active: boolean) {
    await this.getConfig(userId, id);
    return this.prisma.paymentMethodConfig.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteConfig(userId: string, id: string) {
    await this.getConfig(userId, id);
    return this.prisma.paymentMethodConfig.delete({ where: { id } });
  }

  async getConfigAnalytics(userId: string) {
    const configs = await this.prisma.paymentMethodConfig.findMany({ where: { userId } });

    if (configs.length === 0) {
      return {
        totalConfigs: 0,
        activeConfigs: 0,
        totalTransactions: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalTransactions = 0;
    for (const c of configs as any[]) {
      if (c.isActive) activeCount++;
      totalTransactions += c.transactionCount || 0;
    }

    return {
      totalConfigs: configs.length,
      activeConfigs: activeCount,
      totalTransactions,
      analyticsLevel: configs.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
