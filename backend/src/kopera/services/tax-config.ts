import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class TaxConfigService {
  constructor(private prisma: PrismaClient) {}

  async createConfig(userId: string, data: {
    taxType: string;
    jurisdiction: string;
    rate: number;
    currency: string;
    description?: string;
    appliesTo?: string;
  }) {
    const existing = await this.prisma.taxConfig.findFirst({
      where: { userId, taxType: data.taxType, jurisdiction: data.jurisdiction.toUpperCase() },
    });
    if (existing) throw new Error('tax_config_exists');

    return this.prisma.taxConfig.create({
      data: {
        userId,
        taxType: data.taxType.toUpperCase(),
        jurisdiction: data.jurisdiction.toUpperCase(),
        rate: data.rate,
        currency: data.currency.toUpperCase(),
        description: data.description || null,
        appliesTo: data.appliesTo || 'ALL',
        isActive: true,
        reference: `TAX-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getConfigs(userId: string) {
    return this.prisma.taxConfig.findMany({ where: { userId } });
  }

  async getConfig(userId: string, id: string) {
    const config = await this.prisma.taxConfig.findUnique({ where: { id } });
    if (!config) throw new Error('tax_config_not_found');
    if ((config as any).userId !== userId) throw new Error('tax_config_not_found');
    return config;
  }

  async updateRate(userId: string, id: string, rate: number) {
    await this.getConfig(userId, id);
    if (rate < 0 || rate > 1) throw new Error('invalid_tax_rate');
    return this.prisma.taxConfig.update({ where: { id }, data: { rate } });
  }

  async toggleConfig(userId: string, id: string, active: boolean) {
    await this.getConfig(userId, id);
    return this.prisma.taxConfig.update({ where: { id }, data: { isActive: active } });
  }

  async calculateTax(userId: string, taxType: string, jurisdiction: string, amount: bigint) {
    const configs = await this.prisma.taxConfig.findMany({ where: { userId } });
    const config = (configs as any[]).find(
      (c) => c.taxType === taxType.toUpperCase() && c.jurisdiction === jurisdiction.toUpperCase() && c.isActive,
    );

    if (!config) return { taxAmount: BigInt(0), taxApplied: false };

    const taxAmount = BigInt(Math.round(Number(amount) * config.rate));
    return { taxAmount, taxApplied: true, taxType: config.taxType, rate: config.rate };
  }

  async deleteConfig(userId: string, id: string) {
    await this.getConfig(userId, id);
    return this.prisma.taxConfig.delete({ where: { id } });
  }

  async getTaxAnalytics(userId: string) {
    const configs = await this.prisma.taxConfig.findMany({ where: { userId } });

    if (configs.length === 0) {
      return {
        totalConfigs: 0,
        activeConfigs: 0,
        taxTypes: {},
        jurisdictions: [],
        analyticsLevel: 'no_data',
      };
    }

    const active = (configs as any[]).filter((c) => c.isActive).length;
    const taxTypes: Record<string, number> = {};
    const jurisdictions = new Set<string>();
    for (const c of configs as any[]) {
      taxTypes[c.taxType] = (taxTypes[c.taxType] || 0) + 1;
      jurisdictions.add(c.jurisdiction);
    }

    return {
      totalConfigs: configs.length,
      activeConfigs: active,
      taxTypes,
      jurisdictions: [...jurisdictions],
      analyticsLevel: active > 0 ? 'configured' : 'inactive',
    };
  }
}
