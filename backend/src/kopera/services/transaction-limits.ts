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
