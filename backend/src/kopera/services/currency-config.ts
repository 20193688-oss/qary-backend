import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class CurrencyConfigService {
  constructor(private prisma: PrismaClient) {}

  async setConfig(userId: string, data: {
    currency: string;
    displayDecimals?: number;
    roundingMode?: string;
    isDefault?: boolean;
  }) {
    const existing = await this.prisma.currencyConfig.findFirst({
      where: { userId, currency: data.currency.toUpperCase() },
    });

    if (existing) {
      return this.prisma.currencyConfig.update({
        where: { id: (existing as any).id },
        data: {
          displayDecimals: data.displayDecimals ?? (existing as any).displayDecimals,
          roundingMode: data.roundingMode ?? (existing as any).roundingMode,
          isDefault: data.isDefault ?? (existing as any).isDefault,
        },
      });
    }

    if (data.isDefault) {
      await this.prisma.currencyConfig.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.currencyConfig.create({
      data: {
        userId,
        currency: data.currency.toUpperCase(),
        displayDecimals: data.displayDecimals ?? 2,
        roundingMode: data.roundingMode || 'half_up',
        isDefault: data.isDefault || false,
        isActive: true,
        reference: `CCF-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getConfigs(userId: string) {
    return this.prisma.currencyConfig.findMany({ where: { userId } });
  }

  async getConfig(userId: string, id: string) {
    const config = await this.prisma.currencyConfig.findUnique({ where: { id } });
    if (!config) throw new Error('currency_config_not_found');
    if ((config as any).userId !== userId) throw new Error('currency_config_not_found');
    return config;
  }

  async getDefaultCurrency(userId: string) {
    const configs = await this.prisma.currencyConfig.findMany({ where: { userId } });
    const defaultConfig = (configs as any[]).find((c) => c.isDefault);
    return defaultConfig || null;
  }

  async removeConfig(userId: string, id: string) {
    const config = await this.prisma.currencyConfig.findUnique({ where: { id } });
    if (!config) throw new Error('currency_config_not_found');
    if ((config as any).userId !== userId) throw new Error('currency_config_not_found');
    return this.prisma.currencyConfig.delete({ where: { id } });
  }

  async getCurrencyAnalytics(userId: string) {
    const configs = await this.prisma.currencyConfig.findMany({ where: { userId } });

    if (configs.length === 0) {
      return {
        totalConfigs: 0,
        currencies: [],
        hasDefault: false,
        analyticsLevel: 'no_data',
      };
    }

    const currencies = (configs as any[]).map((c) => c.currency);
    const hasDefault = (configs as any[]).some((c) => c.isDefault);
    const roundingModes: Record<string, number> = {};
    for (const c of configs as any[]) {
      roundingModes[c.roundingMode] = (roundingModes[c.roundingMode] || 0) + 1;
    }

    return {
      totalConfigs: configs.length,
      currencies,
      hasDefault,
      roundingModes,
      analyticsLevel: hasDefault ? 'configured' : 'partial',
    };
  }
}
