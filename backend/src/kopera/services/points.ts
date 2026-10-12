import type { PrismaClient } from '@prisma/client';

const TIER_THRESHOLDS = {
  BRONZE: 0,
  SILVER: 1000,
  GOLD: 5000,
  PLATINUM: 20000,
  DIAMOND: 50000,
};

export class PointsService {
  constructor(private prisma: PrismaClient) {}

  async getOrCreate(userId: string) {
    const existing = await this.prisma.koperaPoints.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.koperaPoints.create({ data: { userId } });
  }

  async earn(userId: string, amount: number, reason: string, referenceId?: string) {
    const points = await this.getOrCreate(userId);

    return this.prisma.$transaction(async (tx) => {
      await tx.pointsHistory.create({
        data: {
          pointsId: points.id,
          amount,
          type: 'EARN',
          reason,
          referenceId,
        },
      });

      const newBalance = points.balance + amount;
      const newLifetime = points.lifetimeEarned + amount;
      const newTier = this.calculateTier(newLifetime);

      return tx.koperaPoints.update({
        where: { id: points.id },
        data: {
          balance: newBalance,
          lifetimeEarned: newLifetime,
          tier: newTier,
        },
      });
    });
  }

  async redeem(userId: string, amount: number, reason: string, referenceId?: string) {
    const points = await this.getOrCreate(userId);
    if (points.balance < amount) throw new Error('insufficient_points');

    return this.prisma.$transaction(async (tx) => {
      await tx.pointsHistory.create({
        data: {
          pointsId: points.id,
          amount: -amount,
          type: 'REDEEM',
          reason,
          referenceId,
        },
      });

      return tx.koperaPoints.update({
        where: { id: points.id },
        data: {
          balance: points.balance - amount,
          lifetimeSpent: points.lifetimeSpent + amount,
        },
      });
    });
  }

  async getBalance(userId: string) {
    const points = await this.getOrCreate(userId);
    return {
      balance: points.balance,
      tier: points.tier,
      lifetimeEarned: points.lifetimeEarned,
      lifetimeSpent: points.lifetimeSpent,
      nextTier: this.getNextTier(points.tier),
      pointsToNextTier: this.getPointsToNextTier(points.lifetimeEarned, points.tier),
    };
  }

  async getHistory(userId: string, opts?: { type?: string; limit?: number; offset?: number }) {
    const points = await this.prisma.koperaPoints.findUnique({ where: { userId } });
    if (!points) return [];
    const where: Record<string, unknown> = { pointsId: points.id };
    if (opts?.type) where.type = opts.type;
    return this.prisma.pointsHistory.findMany({
      where,
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async leaderboard(limit = 10) {
    const all = await this.prisma.koperaPoints.findMany({});
    return all
      .sort((a: any, b: any) => b.lifetimeEarned - a.lifetimeEarned)
      .slice(0, Math.min(limit, 50))
      .map((p: any, i: number) => ({
        rank: i + 1,
        userId: p.userId,
        tier: p.tier,
        lifetimeEarned: p.lifetimeEarned,
        balance: p.balance,
      }));
  }

  pointsForTransaction(amountCents: number, type: string, tier: string): number {
    const baseRate: Record<string, number> = {
      PAYMENT: 1,
      TRANSFER: 0.5,
      FX_CONVERSION: 2,
      LOAN_REPAYMENT: 3,
      DEPOSIT: 0.25,
    };
    const tierMultiplier: Record<string, number> = {
      BRONZE: 1, SILVER: 1.2, GOLD: 1.5, PLATINUM: 2, DIAMOND: 3,
    };
    const rate = baseRate[type] ?? 0.5;
    const multiplier = tierMultiplier[tier] ?? 1;
    return Math.floor((amountCents / 100) * rate * multiplier);
  }

  private calculateTier(lifetimeEarned: number): string {
    if (lifetimeEarned >= TIER_THRESHOLDS.DIAMOND) return 'DIAMOND';
    if (lifetimeEarned >= TIER_THRESHOLDS.PLATINUM) return 'PLATINUM';
    if (lifetimeEarned >= TIER_THRESHOLDS.GOLD) return 'GOLD';
    if (lifetimeEarned >= TIER_THRESHOLDS.SILVER) return 'SILVER';
    return 'BRONZE';
  }

  private getNextTier(currentTier: string): string | null {
    const tiers = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];
    const idx = tiers.indexOf(currentTier);
    if (idx < 0 || idx >= tiers.length - 1) return null;
    return tiers[idx + 1]!;
  }

  private getPointsToNextTier(lifetimeEarned: number, currentTier: string): number | null {
    const nextTier = this.getNextTier(currentTier);
    if (!nextTier) return null;
    const threshold = TIER_THRESHOLDS[nextTier as keyof typeof TIER_THRESHOLDS];
    return Math.max(0, threshold - lifetimeEarned);
  }
}
