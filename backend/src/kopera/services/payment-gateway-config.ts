import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentGatewayConfigService {
  constructor(private prisma: PrismaClient) {}

  async createConfig(userId: string, data: {
    gatewayName: string;
    environment: string;
    supportedCurrencies: string;
    merchantId: string;
  }) {
    return this.prisma.paymentGatewayConfig.create({
      data: {
        userId,
        gatewayName: data.gatewayName,
        environment: data.environment.toUpperCase(),
        supportedCurrencies: data.supportedCurrencies,
        merchantId: data.merchantId,
        transactionCount: 0,
        totalVolume: BigInt(0),
        isActive: true,
        reference: `PGC-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getConfigs(userId: string) {
    return this.prisma.paymentGatewayConfig.findMany({ where: { userId } });
  }

  async getConfig(userId: string, id: string) {
    const c = await this.prisma.paymentGatewayConfig.findUnique({ where: { id } });
    if (!c) throw new Error('gateway_config_not_found');
    if ((c as any).userId !== userId) throw new Error('gateway_config_not_found');
    return c;
  }

  async recordTransaction(userId: string, id: string, amount: bigint) {
    const c = await this.getConfig(userId, id);
    if (!(c as any).isActive) throw new Error('gateway_not_active');

    return this.prisma.paymentGatewayConfig.update({
      where: { id },
      data: {
        transactionCount: ((c as any).transactionCount || 0) + 1,
        totalVolume: ((c as any).totalVolume || BigInt(0)) + amount,
        lastUsedAt: new Date(),
      },
    });
  }

  async toggleConfig(userId: string, id: string, active: boolean) {
    await this.getConfig(userId, id);
    return this.prisma.paymentGatewayConfig.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteConfig(userId: string, id: string) {
    await this.getConfig(userId, id);
    return this.prisma.paymentGatewayConfig.delete({ where: { id } });
  }

  async getGatewayAnalytics(userId: string) {
    const configs = await this.prisma.paymentGatewayConfig.findMany({ where: { userId } });

    if (configs.length === 0) {
      return {
        totalGateways: 0,
        activeGateways: 0,
        totalVolume: '0',
        totalTransactions: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalVolume = BigInt(0);
    let totalTransactions = 0;
    for (const c of configs as any[]) {
      if (c.isActive) activeCount++;
      totalVolume += (c.totalVolume || BigInt(0)) as bigint;
      totalTransactions += c.transactionCount || 0;
    }

    return {
      totalGateways: configs.length,
      activeGateways: activeCount,
      totalVolume: totalVolume.toString(),
      totalTransactions,
      analyticsLevel: configs.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
