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

  async getEarningSummary(userId: string) {
    const pts = await this.prisma.koperaPoints.findUnique({ where: { userId } });
    if (!pts) {
      return { totalEarned: 0, totalRedeemed: 0, balance: 0, tier: 'BRONZE', byReason: {} };
    }
    const history = await this.prisma.pointsHistory.findMany({
      where: { pointsId: pts.id },
    });
    const byReason: Record<string, { earned: number; redeemed: number; count: number }> = {};
    for (const h of history) {
      if (!byReason[h.reason]) byReason[h.reason] = { earned: 0, redeemed: 0, count: 0 };
      byReason[h.reason].count++;
      if (h.type === 'EARN') byReason[h.reason].earned += h.amount;
      else byReason[h.reason].redeemed += Math.abs(h.amount);
    }
    return {
      totalEarned: pts.lifetimeEarned,
      totalRedeemed: pts.lifetimeSpent,
      balance: pts.balance,
      tier: pts.tier,
      byReason,
    };
  }

  async getTierProgress(userId: string) {
    const pts = await this.getOrCreate(userId);
    const history = await this.prisma.pointsHistory.findMany({
      where: { pointsId: pts.id, type: 'EARN' },
    });

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    let last30DaysEarned = 0;
    for (const h of history) {
      if (new Date(h.createdAt).getTime() >= thirtyDaysAgo) {
        last30DaysEarned += h.amount;
      }
    }

    const dailyRate = last30DaysEarned / 30;
    const nextTier = this.getNextTier(pts.tier);
    const pointsToNext = this.getPointsToNextTier(pts.lifetimeEarned, pts.tier);
    let projectedDaysToNextTier: number | null = null;
    if (nextTier && pointsToNext !== null && dailyRate > 0) {
      projectedDaysToNextTier = Math.ceil(pointsToNext / dailyRate);
    }

    const tierMultiplier: Record<string, number> = {
      BRONZE: 1, SILVER: 1.2, GOLD: 1.5, PLATINUM: 2, DIAMOND: 3,
    };

    return {
      currentTier: pts.tier,
      lifetimeEarned: pts.lifetimeEarned,
      balance: pts.balance,
      nextTier,
      pointsToNextTier: pointsToNext,
      earningVelocity: {
        last30Days: last30DaysEarned,
        dailyAverage: Math.round(dailyRate * 10) / 10,
      },
      projectedDaysToNextTier,
      currentMultiplier: tierMultiplier[pts.tier] ?? 1,
    };
  }

  async getRedemptionAnalysis(userId: string) {
    const pts = await this.getOrCreate(userId);
    const history = await this.prisma.pointsHistory.findMany({ where: { pointsId: pts.id } });

    let totalEarned = 0;
    let totalRedeemed = 0;
    let earnCount = 0;
    let redeemCount = 0;
    const byMonth: Record<string, { earned: number; redeemed: number }> = {};

    for (const h of history) {
      const month = new Date(h.createdAt).toISOString().slice(0, 7);
      if (!byMonth[month]) byMonth[month] = { earned: 0, redeemed: 0 };

      if (h.type === 'EARN') {
        totalEarned += h.amount;
        earnCount++;
        byMonth[month].earned += h.amount;
      } else {
        totalRedeemed += Math.abs(h.amount);
        redeemCount++;
        byMonth[month].redeemed += Math.abs(h.amount);
      }
    }

    const redemptionRate = totalEarned > 0
      ? Math.round((totalRedeemed / totalEarned) * 10000) / 100
      : 0;
    const avgEarnAmount = earnCount > 0 ? Math.round(totalEarned / earnCount) : 0;
    const avgRedeemAmount = redeemCount > 0 ? Math.round(totalRedeemed / redeemCount) : 0;

    const months = Object.keys(byMonth).sort();
    const trend = months.map((m) => ({
      month: m,
      earned: byMonth[m].earned,
      redeemed: byMonth[m].redeemed,
      net: byMonth[m].earned - byMonth[m].redeemed,
    }));

    return {
      balance: pts.balance,
      tier: pts.tier,
      totalEarned,
      totalRedeemed,
      redemptionRate,
      earnCount,
      redeemCount,
      avgEarnAmount,
      avgRedeemAmount,
      trend,
    };
  }

  async getEngagementScore(userId: string) {
    const pts = await this.getOrCreate(userId);

    const history = await this.prisma.pointsHistory.findMany({
      where: { pointsId: pts.id },
      orderBy: { createdAt: 'desc' },
    });

    const earnEvents = history.filter((h: any) => h.type === 'EARN');
    const redeemEvents = history.filter((h: any) => h.type === 'REDEEM');

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentEarns = earnEvents.filter((h: any) => new Date(h.createdAt) >= thirtyDaysAgo);
    const recentRedeems = redeemEvents.filter((h: any) => new Date(h.createdAt) >= thirtyDaysAgo);

    const activityFrequency = Math.min(100, recentEarns.length * 10);

    const totalEarned = earnEvents.reduce((sum: number, h: any) => sum + h.amount, 0);
    const totalRedeemed = redeemEvents.reduce((sum: number, h: any) => sum + Math.abs(h.amount), 0);
    const redemptionEngagement = totalEarned > 0
      ? Math.min(100, Math.round((totalRedeemed / totalEarned) * 100))
      : 0;

    const tierScore = (() => {
      switch (pts.tier) {
        case 'DIAMOND': return 100;
        case 'PLATINUM': return 80;
        case 'GOLD': return 60;
        case 'SILVER': return 40;
        case 'BRONZE': return 20;
        default: return 10;
      }
    })();

    const consistencyScore = (() => {
      if (earnEvents.length < 2) return 0;
      const uniqueDays = new Set(
        earnEvents.map((h: any) => {
          const d = new Date(h.createdAt);
          return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        })
      );
      return Math.min(100, uniqueDays.size * 5);
    })();

    const engagementScore = Math.round(
      (activityFrequency * 0.3 + redemptionEngagement * 0.2 + tierScore * 0.3 + consistencyScore * 0.2)
    );

    let engagementLevel: string;
    if (engagementScore >= 80) engagementLevel = 'highly_engaged';
    else if (engagementScore >= 50) engagementLevel = 'engaged';
    else if (engagementScore >= 20) engagementLevel = 'moderate';
    else engagementLevel = 'low';

    return {
      userId,
      engagementScore,
      engagementLevel,
      components: {
        activityFrequency,
        redemptionEngagement,
        tierScore,
        consistencyScore,
      },
      recentActivity: {
        earnsLast30Days: recentEarns.length,
        redeemsLast30Days: recentRedeems.length,
        pointsEarnedLast30Days: recentEarns.reduce((s: number, h: any) => s + h.amount, 0),
        pointsRedeemedLast30Days: recentRedeems.reduce((s: number, h: any) => s + Math.abs(h.amount), 0),
      },
      currentTier: pts.tier,
      balance: pts.balance,
      lifetimeEarned: pts.lifetimeEarned,
    };
  }

  async getPointsDecayRisk(userId: string) {
    const pts = await this.getOrCreate(userId);
    const now = new Date();
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const history = await this.prisma.pointsHistory.findMany({
      where: { pointsId: pts.id, type: 'EARN' },
      orderBy: { createdAt: 'desc' },
    });

    const earnsLast7 = history.filter((h: any) => new Date(h.createdAt) >= d7);
    const earnsLast30 = history.filter((h: any) => new Date(h.createdAt) >= d30);
    const earnsLast90 = history.filter((h: any) => new Date(h.createdAt) >= d90);

    const pointsLast7 = earnsLast7.reduce((s: number, h: any) => s + h.amount, 0);
    const pointsLast30 = earnsLast30.reduce((s: number, h: any) => s + h.amount, 0);
    const pointsLast90 = earnsLast90.reduce((s: number, h: any) => s + h.amount, 0);

    const avgDaily30 = pointsLast30 / 30;
    const avgDaily90 = pointsLast90 / 90;
    const decayRate = avgDaily90 > 0
      ? Math.round((1 - avgDaily30 / avgDaily90) * 10000) / 100
      : 0;

    const currentTier = pts.tier;
    const tierThreshold = TIER_THRESHOLDS[currentTier as keyof typeof TIER_THRESHOLDS] ?? 0;
    const prevTierThreshold = this.getPrevTierThreshold(currentTier);
    const surplus = pts.lifetimeEarned - tierThreshold;

    let projectedDaysUntilTierLoss: number | null = null;
    if (currentTier !== 'BRONZE' && avgDaily30 > 0 && decayRate > 0) {
      const effectiveLossRate = avgDaily30 * (decayRate / 100);
      if (effectiveLossRate > 0) {
        projectedDaysUntilTierLoss = Math.round(surplus / effectiveLossRate);
      }
    }

    const riskLevel = decayRate > 50 ? 'high' : decayRate > 20 ? 'medium' : 'low';

    return {
      currentTier,
      lifetimeEarned: pts.lifetimeEarned,
      balance: pts.balance,
      activity: {
        last7Days: { transactions: earnsLast7.length, pointsEarned: pointsLast7 },
        last30Days: { transactions: earnsLast30.length, pointsEarned: pointsLast30 },
        last90Days: { transactions: earnsLast90.length, pointsEarned: pointsLast90 },
      },
      decayRate,
      riskLevel,
      projectedDaysUntilTierLoss,
      nextTierDown: currentTier !== 'BRONZE' ? this.getPrevTier(currentTier) : null,
      surplusAboveCurrentTier: surplus,
    };
  }

  private getPrevTier(tier: string): string | null {
    const tiers = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];
    const idx = tiers.indexOf(tier);
    if (idx <= 0) return null;
    return tiers[idx - 1]!;
  }

  async getRewardVelocity(userId: string) {
    const pts = await this.getOrCreate(userId);
    const history = await this.prisma.pointsHistory.findMany({
      where: { pointsId: pts.id },
      orderBy: { createdAt: 'asc' },
    });

    if (history.length === 0) {
      return {
        totalTransactions: 0,
        earnVelocity: 0,
        redeemVelocity: 0,
        netVelocityPerDay: 0,
        byWeek: [] as Array<{ week: string; earned: number; redeemed: number; net: number }>,
        acceleration: 0,
        trend: 'none' as const,
      };
    }

    const weekMap = new Map<string, { earned: number; redeemed: number }>();

    for (const h of history) {
      const d = new Date(h.createdAt);
      const weekStart = new Date(d);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      const entry = weekMap.get(key) ?? { earned: 0, redeemed: 0 };
      if (h.type === 'EARN') entry.earned += h.amount;
      else entry.redeemed += h.amount;
      weekMap.set(key, entry);
    }

    const byWeek = Array.from(weekMap.entries())
      .map(([week, data]) => ({
        week,
        earned: data.earned,
        redeemed: data.redeemed,
        net: data.earned - data.redeemed,
      }))
      .sort((a, b) => a.week.localeCompare(b.week));

    const firstDate = new Date(history[0].createdAt).getTime();
    const lastDate = new Date(history[history.length - 1].createdAt).getTime();
    const totalDays = Math.max(1, (lastDate - firstDate) / (24 * 60 * 60 * 1000));

    const totalEarned = history.filter(h => h.type === 'EARN').reduce((s, h) => s + h.amount, 0);
    const totalRedeemed = history.filter(h => h.type === 'REDEEM').reduce((s, h) => s + h.amount, 0);
    const earnVelocity = Math.round((totalEarned / totalDays) * 100) / 100;
    const redeemVelocity = Math.round((totalRedeemed / totalDays) * 100) / 100;
    const netVelocityPerDay = Math.round(((totalEarned - totalRedeemed) / totalDays) * 100) / 100;

    let acceleration = 0;
    let trend: 'accelerating' | 'stable' | 'decelerating' | 'none' = 'none';
    if (byWeek.length >= 4) {
      const half = Math.floor(byWeek.length / 2);
      const firstHalfAvg = byWeek.slice(0, half).reduce((s, w) => s + w.net, 0) / half;
      const secondHalfAvg = byWeek.slice(half).reduce((s, w) => s + w.net, 0) / (byWeek.length - half);
      acceleration = firstHalfAvg !== 0
        ? Math.round(((secondHalfAvg - firstHalfAvg) / Math.abs(firstHalfAvg)) * 10000) / 100
        : 0;
      trend = acceleration > 10 ? 'accelerating' : acceleration < -10 ? 'decelerating' : 'stable';
    }

    return {
      totalTransactions: history.length,
      earnVelocity,
      redeemVelocity,
      netVelocityPerDay,
      byWeek,
      acceleration,
      trend,
    };
  }

  async getPointsEconomyHealth(userId: string) {
    const account = await this.getOrCreate(userId);
    const history = await this.prisma.pointsHistory.findMany({
      where: { pointsId: account.id },
      orderBy: { createdAt: 'asc' },
    });

    const earned = history.filter((t) => t.type === 'EARN');
    const redeemed = history.filter((t) => t.type === 'REDEEM');

    const totalEarned = earned.reduce((s, t) => s + t.amount, 0);
    const totalRedeemed = redeemed.reduce((s, t) => s + Math.abs(t.amount), 0);
    const earnToBurnRatio = totalRedeemed > 0 ? Math.round((totalEarned / totalRedeemed) * 100) / 100 : totalEarned > 0 ? Infinity : 0;

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86400000;
    const recentEarned = earned.filter((t) => new Date(t.createdAt).getTime() > thirtyDaysAgo);
    const recentRedeemed = redeemed.filter((t) => new Date(t.createdAt).getTime() > thirtyDaysAgo);
    const recentEarnTotal = recentEarned.reduce((s, t) => s + t.amount, 0);
    const recentRedeemTotal = recentRedeemed.reduce((s, t) => s + Math.abs(t.amount), 0);

    const utilizationRate = totalEarned > 0 ? Math.round((totalRedeemed / totalEarned) * 100) : 0;

    const daysSinceFirst = history.length > 0
      ? Math.max(1, Math.ceil((now - new Date(history[0]!.createdAt).getTime()) / 86400000))
      : 0;
    const accumulationVelocity = daysSinceFirst > 0
      ? Math.round((account.balance / daysSinceFirst) * 10) / 10
      : 0;

    let healthStatus: 'healthy' | 'hoarding' | 'depleting' | 'inactive';
    if (history.length === 0) healthStatus = 'inactive';
    else if (utilizationRate > 80) healthStatus = 'depleting';
    else if (utilizationRate < 20 && totalEarned > 1000) healthStatus = 'hoarding';
    else healthStatus = 'healthy';

    return {
      currentBalance: account.balance,
      lifetimeEarned: account.lifetimeEarned,
      totalEarned,
      totalRedeemed,
      earnToBurnRatio: earnToBurnRatio === Infinity ? 'Infinity' : earnToBurnRatio,
      utilizationRate,
      accumulationVelocity,
      recent30Days: {
        earned: recentEarnTotal,
        redeemed: recentRedeemTotal,
      },
      healthStatus,
    };
  }

  async getPointsSeasonalityAnalysis(userId: string) {
    const points = await this.prisma.koperaPoints.findFirst({ where: { userId } });
    if (!points) {
      return {
        totalTransactions: 0,
        byMonth: [],
        peakEarningMonth: null,
        peakRedemptionMonth: null,
        seasonalTrend: 'insufficient_data',
      };
    }

    const history = await this.prisma.pointsHistory.findMany({
      where: { pointsId: points.id },
    });

    if (history.length === 0) {
      return {
        totalTransactions: 0,
        byMonth: [],
        peakEarningMonth: null,
        peakRedemptionMonth: null,
        seasonalTrend: 'insufficient_data',
      };
    }

    const monthMap = new Map<number, { earned: number; redeemed: number; count: number }>();
    for (const h of history) {
      const month = new Date(h.createdAt).getMonth();
      const entry = monthMap.get(month) || { earned: 0, redeemed: 0, count: 0 };
      entry.count++;
      const amt = Number((h as any).amount || 0);
      if ((h as any).type === 'EARN') {
        entry.earned += amt;
      } else {
        entry.redeemed += Math.abs(amt);
      }
      monthMap.set(month, entry);
    }

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const byMonth = Array.from(monthMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([m, data]) => ({
        month: months[m],
        monthIndex: m,
        earned: data.earned,
        redeemed: data.redeemed,
        net: data.earned - data.redeemed,
        transactionCount: data.count,
      }));

    let peakEarningMonth: string | null = null;
    let maxEarned = 0;
    let peakRedemptionMonth: string | null = null;
    let maxRedeemed = 0;

    for (const b of byMonth) {
      if (b.earned > maxEarned) { maxEarned = b.earned; peakEarningMonth = b.month!; }
      if (b.redeemed > maxRedeemed) { maxRedeemed = b.redeemed; peakRedemptionMonth = b.month!; }
    }

    const totalNet = byMonth.reduce((s, b) => s + b.net, 0);
    const seasonalTrend = totalNet > 0 ? 'earning_dominant' : totalNet < 0 ? 'redemption_dominant' : 'balanced';

    return {
      totalTransactions: history.length,
      byMonth,
      peakEarningMonth,
      peakRedemptionMonth,
      seasonalTrend,
    };
  }

  private getPrevTierThreshold(tier: string): number {
    const prev = this.getPrevTier(tier);
    if (!prev) return 0;
    return TIER_THRESHOLDS[prev as keyof typeof TIER_THRESHOLDS] ?? 0;
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

  async getPointsConcentrationAnalysis(userId: string) {
    const history = await this.prisma.pointsHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (history.length === 0) {
      return {
        totalTransactions: 0,
        earnTransactions: 0,
        redeemTransactions: 0,
        topEarnReasons: [] as { reason: string; count: number; totalAmount: number }[],
        topRedeemReasons: [] as { reason: string; count: number; totalAmount: number }[],
        concentrationScore: 0,
        recommendations: [] as string[],
      };
    }

    const earnMap = new Map<string, { count: number; totalAmount: number }>();
    const redeemMap = new Map<string, { count: number; totalAmount: number }>();
    let earnCount = 0;
    let redeemCount = 0;

    for (const h of history) {
      const type = ((h as any).type || '').toUpperCase();
      const reason = (h as any).reason || 'unknown';
      const amount = Number((h as any).amount || 0);

      if (type === 'EARN' || type === 'CREDIT') {
        earnCount++;
        const existing = earnMap.get(reason) || { count: 0, totalAmount: 0 };
        existing.count++;
        existing.totalAmount += amount;
        earnMap.set(reason, existing);
      } else if (type === 'REDEEM' || type === 'DEBIT') {
        redeemCount++;
        const existing = redeemMap.get(reason) || { count: 0, totalAmount: 0 };
        existing.count++;
        existing.totalAmount += amount;
        redeemMap.set(reason, existing);
      }
    }

    const topEarnReasons = Array.from(earnMap.entries())
      .map(([reason, data]) => ({ reason, ...data }))
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 5);

    const topRedeemReasons = Array.from(redeemMap.entries())
      .map(([reason, data]) => ({ reason, ...data }))
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 5);

    const earnShares = topEarnReasons.map(r => r.count / Math.max(earnCount, 1));
    const hhi = earnShares.reduce((sum, s) => sum + s * s, 0);
    const concentrationScore = Number((hhi * 100).toFixed(2));

    const recommendations: string[] = [];
    if (concentrationScore > 70) recommendations.push('Earning sources are highly concentrated — diversify point-earning activities');
    if (redeemCount === 0 && earnCount > 10) recommendations.push('No redemptions recorded — consider promoting redemption options');
    if (topEarnReasons.length === 1) recommendations.push('All earnings from a single source — introduce additional earning channels');

    return {
      totalTransactions: history.length,
      earnTransactions: earnCount,
      redeemTransactions: redeemCount,
      topEarnReasons,
      topRedeemReasons,
      concentrationScore,
      recommendations,
    };
  }

  async getPointsRedemptionEfficiency(userId: string) {
    const points = await this.prisma.koperaPoints.findUnique({ where: { userId } });
    const history = await this.prisma.pointsHistory.findMany({ where: { userId } });

    const totalBalance = points?.balance ?? 0;
    const totalEarned = history.filter(h => {
      const t = ((h as any).type || '').toUpperCase();
      return t === 'EARN' || t === 'CREDIT';
    }).reduce((s, h) => s + Math.abs((h as any).amount ?? 0), 0);

    const totalRedeemed = history.filter(h => {
      const t = ((h as any).type || '').toUpperCase();
      return t === 'REDEEM' || t === 'DEBIT';
    }).reduce((s, h) => s + Math.abs((h as any).amount ?? 0), 0);

    const redemptionRate = totalEarned > 0
      ? Math.round((totalRedeemed / totalEarned) * 10000) / 100
      : 0;

    const unusedPoints = totalBalance;
    const wasteRisk = totalEarned > 0
      ? Math.round((unusedPoints / totalEarned) * 10000) / 100
      : 0;

    let efficiencyScore = 100;
    if (redemptionRate < 20) efficiencyScore -= 40;
    else if (redemptionRate < 50) efficiencyScore -= 20;
    if (wasteRisk > 80) efficiencyScore -= 25;
    efficiencyScore = Math.max(0, efficiencyScore);

    const efficiencyLevel = efficiencyScore >= 70 ? 'optimal'
      : efficiencyScore >= 40 ? 'underutilized' : 'wasteful';

    const recommendations: string[] = [];
    if (redemptionRate < 30) recommendations.push('Redeem accumulated points before they expire');
    if (unusedPoints > 1000) recommendations.push('You have significant unused points — check available rewards');
    if (history.length === 0) recommendations.push('Start earning points through eligible transactions');

    return {
      totalEarned,
      totalRedeemed,
      currentBalance: totalBalance,
      redemptionRate,
      wasteRisk,
      efficiencyScore,
      efficiencyLevel,
      recommendations,
    };
  }

  async getPointsExpiryRisk(userId: string) {
    const points = await this.prisma.koperaPoints.findFirst({ where: { userId } });
    const history = await this.prisma.pointsHistory.findMany({ where: { userId } });

    if (!points && history.length === 0) {
      return {
        currentBalance: 0,
        riskLevel: 'no_data' as const,
        expiryScore: 0,
        earnedLast90Days: 0,
        redeemedLast90Days: 0,
        recommendations: [],
      };
    }

    const balance = points?.balance ?? 0;
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 86400000;

    let earnedLast90 = 0;
    let redeemedLast90 = 0;
    let lastActivityMs = 0;

    for (const h of history) {
      const ts = new Date(h.createdAt).getTime();
      if (ts > lastActivityMs) lastActivityMs = ts;

      if (ts >= ninetyDaysAgo) {
        const hType = (h as any).type || (h as any).action || '';
        if (hType === 'EARN' || hType === 'CREDIT' || hType === 'earn') {
          earnedLast90 += h.points;
        } else if (hType === 'REDEEM' || hType === 'DEBIT' || hType === 'redeem') {
          redeemedLast90 += h.points;
        }
      }
    }

    const daysSinceActivity = lastActivityMs > 0 ? Math.floor((now - lastActivityMs) / 86400000) : 999;

    let expiryScore = 0;
    if (daysSinceActivity > 180) expiryScore += 40;
    else if (daysSinceActivity > 90) expiryScore += 20;
    else if (daysSinceActivity > 30) expiryScore += 10;

    if (balance > 0 && redeemedLast90 === 0) expiryScore += 30;
    if (earnedLast90 === 0 && balance > 0) expiryScore += 20;
    expiryScore = Math.min(100, expiryScore);

    const riskLevel = expiryScore >= 60 ? 'high' : expiryScore >= 30 ? 'moderate' : 'low';

    const recommendations: string[] = [];
    if (expiryScore >= 60) recommendations.push('Points at high risk of expiry — redeem soon');
    if (daysSinceActivity > 90) recommendations.push('No recent activity — points may expire');
    if (balance > 0 && redeemedLast90 === 0) recommendations.push('Balance unused — explore redemption options');

    return {
      currentBalance: balance,
      riskLevel,
      expiryScore,
      daysSinceLastActivity: daysSinceActivity,
      earnedLast90Days: earnedLast90,
      redeemedLast90Days: redeemedLast90,
      recommendations,
    };
  }

  async getPointsAccumulationTrend(userId: string) {
    const history = await this.prisma.pointsHistory.findMany({ where: { userId } });

    if (history.length === 0) {
      return {
        totalTransactions: 0,
        trendScore: 0,
        trendLevel: 'no_data' as const,
        monthlyBreakdown: [] as { month: string; earned: number; spent: number; net: number }[],
        recommendations: [] as string[],
      };
    }

    const monthMap = new Map<string, { earned: number; spent: number }>();

    for (const h of history) {
      const date = new Date((h as any).createdAt);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!monthMap.has(key)) monthMap.set(key, { earned: 0, spent: 0 });
      const bucket = monthMap.get(key)!;

      const type = (h as any).type ?? (h as any).action ?? 'earn';
      const pts = Math.abs((h as any).points ?? (h as any).amount ?? 0);

      if (type === 'earn' || type === 'EARN' || type === 'credit') bucket.earned += pts;
      else if (type === 'redeem' || type === 'REDEEM' || type === 'debit') bucket.spent += pts;
    }

    const monthlyBreakdown = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, earned: data.earned, spent: data.spent, net: data.earned - data.spent }));

    const activeMonths = monthlyBreakdown.length;
    const totalEarned = monthlyBreakdown.reduce((s, m) => s + m.earned, 0);
    const avgMonthlyEarning = activeMonths > 0 ? Math.round(totalEarned / activeMonths) : 0;

    let growing = 0;
    for (let i = 1; i < monthlyBreakdown.length; i++) {
      if (monthlyBreakdown[i].earned > monthlyBreakdown[i - 1].earned) growing++;
    }
    const growthRate = monthlyBreakdown.length > 1
      ? Math.round((growing / (monthlyBreakdown.length - 1)) * 100) : 0;

    let trendScore = 0;
    if (growthRate >= 60) trendScore += 40;
    else if (growthRate >= 30) trendScore += 20;
    if (activeMonths >= 6) trendScore += 25;
    else if (activeMonths >= 3) trendScore += 15;
    if (avgMonthlyEarning >= 100) trendScore += 20;
    else if (avgMonthlyEarning >= 30) trendScore += 10;
    trendScore += 15;
    trendScore = Math.min(100, trendScore);

    const trendLevel = trendScore >= 70 ? 'growing'
      : trendScore >= 40 ? 'stable' : 'declining';

    const recommendations: string[] = [];
    if (growthRate < 30) recommendations.push('Points earning is slowing — explore more earning opportunities');
    if (activeMonths < 3) recommendations.push('Limited history — keep earning to build a trend');
    if (trendLevel === 'growing') recommendations.push('Points accumulation trend is positive');

    return {
      totalTransactions: history.length,
      activeMonths,
      avgMonthlyEarning,
      growthRate,
      trendScore,
      trendLevel,
      monthlyBreakdown,
      recommendations,
    };
  }
}
