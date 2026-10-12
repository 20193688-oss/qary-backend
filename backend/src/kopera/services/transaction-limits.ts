import type { PrismaClient } from '@prisma/client';

export class TransactionLimitService {
  constructor(private prisma: PrismaClient) {}

  async setLimit(params: {
    userId: string;
    currency: string;
    limitType: string;
    maxAmount: bigint;
  }) {
    const limitType = params.limitType.toLowerCase();
    if (limitType !== 'daily' && limitType !== 'monthly') {
      throw new Error('invalid_limit_type');
    }

    return this.prisma.transactionLimit.upsert({
      where: {
        userId_currency_limitType: {
          userId: params.userId,
          currency: params.currency.toUpperCase(),
          limitType,
        },
      },
      update: { maxAmount: params.maxAmount },
      create: {
        userId: params.userId,
        currency: params.currency.toUpperCase(),
        limitType,
        maxAmount: params.maxAmount,
        currentUsage: BigInt(0),
        periodStart: this.periodStart(limitType),
      },
    });
  }

  async getLimits(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { userId },
    });
    return limits.map((l) => this.refreshIfNeeded(l));
  }

  async getLimit(userId: string, currency: string, limitType: string) {
    const limit = await this.prisma.transactionLimit.findFirst({
      where: { userId, currency: currency.toUpperCase(), limitType: limitType.toLowerCase() },
    });
    if (!limit) return null;
    return this.refreshIfNeeded(limit);
  }

  async checkAndIncrement(userId: string, currency: string, amount: bigint): Promise<{ allowed: boolean; reason?: string }> {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { userId, currency: currency.toUpperCase() },
    });

    for (const raw of limits) {
      const limit = this.refreshIfNeeded(raw);
      if (limit.currentUsage + amount > limit.maxAmount) {
        return { allowed: false, reason: `${limit.limitType}_limit_exceeded` };
      }
    }

    for (const limit of limits) {
      const refreshed = this.refreshIfNeeded(limit);
      await this.prisma.transactionLimit.update({
        where: { id: refreshed.id },
        data: {
          currentUsage: refreshed.currentUsage + amount,
          periodStart: refreshed.periodStart,
        },
      });
    }

    return { allowed: true };
  }

  async checkAvailable(userId: string, currency: string, amount: bigint): Promise<{ allowed: boolean; reason?: string }> {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { userId, currency: currency.toUpperCase() },
    });

    for (const raw of limits) {
      const limit = this.refreshIfNeeded(raw);
      if (limit.currentUsage + amount > limit.maxAmount) {
        return { allowed: false, reason: `${limit.limitType}_limit_exceeded` };
      }
    }

    return { allowed: true };
  }

  async getUsageSummary(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    const refreshed = limits.map((l) => this.refreshIfNeeded(l));

    const byType: Record<string, number> = {};
    let totalMaxAmount = BigInt(0);
    let totalCurrentUsage = BigInt(0);

    for (const l of refreshed) {
      byType[l.limitType] = (byType[l.limitType] ?? 0) + 1;
      totalMaxAmount += l.maxAmount;
      totalCurrentUsage += l.currentUsage;
    }

    return {
      totalLimits: refreshed.length,
      byType,
      totalMaxAmount,
      totalCurrentUsage,
      utilizationPercent: totalMaxAmount > BigInt(0)
        ? Number((totalCurrentUsage * BigInt(10000)) / totalMaxAmount) / 100
        : 0,
    };
  }

  async getUtilizationReport(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    const refreshed = limits.map((l) => this.refreshIfNeeded(l));

    const details = refreshed.map((l: any) => {
      const utilization = l.maxAmount > BigInt(0)
        ? Number((l.currentUsage * BigInt(10000)) / l.maxAmount) / 100
        : 0;
      const headroom = l.maxAmount - l.currentUsage;
      const nearLimit = utilization >= 80;

      return {
        id: l.id,
        currency: l.currency,
        limitType: l.limitType,
        maxAmount: l.maxAmount,
        currentUsage: l.currentUsage,
        headroom: headroom > BigInt(0) ? headroom : BigInt(0),
        utilization,
        nearLimit,
      };
    });

    const nearLimitCount = details.filter(d => d.nearLimit).length;

    return {
      totalLimits: details.length,
      nearLimitCount,
      details,
    };
  }

  async removeLimit(userId: string, currency: string, limitType: string) {
    const limit = await this.prisma.transactionLimit.findFirst({
      where: { userId, currency: currency.toUpperCase(), limitType: limitType.toLowerCase() },
    });
    if (!limit) throw new Error('limit_not_found');
    if (limit.userId !== userId) throw new Error('forbidden');

    return this.prisma.transactionLimit.delete({ where: { id: limit.id } });
  }

  private periodStart(limitType: string): Date {
    const now = new Date();
    if (limitType === 'daily') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  private refreshIfNeeded(limit: any): any {
    const periodStart = this.periodStart(limit.limitType);
    if (limit.periodStart < periodStart) {
      return { ...limit, currentUsage: BigInt(0), periodStart };
    }
    return limit;
  }
}
