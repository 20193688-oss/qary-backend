import type { PrismaClient } from '@prisma/client';

export class CurrencyExchangeRateService {
  constructor(private prisma: PrismaClient) {}

  async createRate(userId: string, data: {
    baseCurrency: string;
    targetCurrency: string;
    rate: number;
    marginPercent: number;
    source: string;
  }) {
    return this.prisma.currencyExchangeRate.create({
      data: {
        userId,
        baseCurrency: data.baseCurrency.toUpperCase(),
        targetCurrency: data.targetCurrency.toUpperCase(),
        rate: data.rate,
        marginPercent: data.marginPercent,
        effectiveRate: data.rate * (1 + data.marginPercent / 100),
        source: data.source.toUpperCase(),
        isActive: true,
        usageCount: 0,
        totalVolumeConverted: BigInt(0),
      },
    });
  }

  async getRates(userId: string) {
    return this.prisma.currencyExchangeRate.findMany({ where: { userId } });
  }

  async getRate(userId: string, id: string) {
    const r = await this.prisma.currencyExchangeRate.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rate_not_found');
    return r;
  }

  async updateRate(userId: string, id: string, data: { rate: number; marginPercent: number }) {
    const r = await this.prisma.currencyExchangeRate.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rate_not_found');
    return this.prisma.currencyExchangeRate.update({
      where: { id },
      data: {
        rate: data.rate,
        marginPercent: data.marginPercent,
        effectiveRate: data.rate * (1 + data.marginPercent / 100),
        updatedAt: new Date(),
      },
    });
  }

  async recordUsage(userId: string, id: string, volume: bigint) {
    const r = await this.prisma.currencyExchangeRate.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rate_not_found');
    if (!r.isActive) throw new Error('rate_not_active');
    return this.prisma.currencyExchangeRate.update({
      where: { id },
      data: {
        usageCount: r.usageCount + 1,
        totalVolumeConverted: (r.totalVolumeConverted ?? BigInt(0)) + volume,
      },
    });
  }

  async toggleRate(userId: string, id: string, active: boolean) {
    const r = await this.prisma.currencyExchangeRate.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rate_not_found');
    return this.prisma.currencyExchangeRate.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteRate(userId: string, id: string) {
    const r = await this.prisma.currencyExchangeRate.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rate_not_found');
    return this.prisma.currencyExchangeRate.delete({ where: { id } });
  }

  async getRateAnalytics(userId: string) {
    const all = await this.prisma.currencyExchangeRate.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalRates: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((r) => r.isActive).length;
    let totalUsage = 0;
    let totalVolume = BigInt(0);
    for (const r of all) {
      totalUsage += r.usageCount;
      totalVolume += r.totalVolumeConverted ?? BigInt(0);
    }
    const bySource: Record<string, number> = {};
    for (const r of all) bySource[r.source] = (bySource[r.source] || 0) + 1;
    return {
      totalRates: all.length,
      activeCount,
      totalUsage,
      totalVolumeConverted: totalVolume.toString(),
      bySource,
      analyticsLevel: 'full' as const,
    };
  }
}
