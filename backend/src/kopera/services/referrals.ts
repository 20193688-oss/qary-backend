import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

const REFERRAL_BONUS_POINTS = 500;

export class ReferralService {
  constructor(private prisma: PrismaClient) {}

  async getOrCreateCode(userId: string): Promise<string> {
    const existing = await this.prisma.referral.findFirst({
      where: { referrerId: userId },
    });
    if (existing) return existing.code;

    const code = randomBytes(4).toString('hex').toUpperCase();
    await this.prisma.referral.create({
      data: {
        referrerId: userId,
        code,
        status: 'active',
        signupCount: 0,
        rewardedCount: 0,
        totalPointsEarned: 0,
      },
    });
    return code;
  }

  async getByCode(code: string) {
    return this.prisma.referral.findFirst({ where: { code: code.toUpperCase() } });
  }

  async getByUser(userId: string) {
    return this.prisma.referral.findFirst({ where: { referrerId: userId } });
  }

  async recordSignup(code: string, referredUserId: string) {
    const referral = await this.prisma.referral.findFirst({
      where: { code: code.toUpperCase() },
    });
    if (!referral) throw new Error('invalid_referral_code');
    if (referral.status !== 'active') throw new Error('referral_inactive');
    if (referral.referrerId === referredUserId) throw new Error('cannot_refer_self');

    const alreadyReferred = await this.prisma.referralSignup.findFirst({
      where: { referredUserId },
    });
    if (alreadyReferred) throw new Error('already_referred');

    await this.prisma.referralSignup.create({
      data: {
        referralId: referral.id,
        referredUserId,
        status: 'signed_up',
      },
    });

    await this.prisma.referral.update({
      where: { id: referral.id },
      data: { signupCount: referral.signupCount + 1 },
    });

    return referral;
  }

  async rewardReferrer(referredUserId: string) {
    const signup = await this.prisma.referralSignup.findFirst({
      where: { referredUserId, status: 'signed_up' },
    });
    if (!signup) return null;

    const referral = await this.prisma.referral.findUnique({
      where: { id: signup.referralId },
    });
    if (!referral) return null;

    await this.prisma.referralSignup.update({
      where: { id: signup.id },
      data: { status: 'rewarded', rewardedAt: new Date() },
    });

    await this.prisma.referral.update({
      where: { id: referral.id },
      data: {
        rewardedCount: referral.rewardedCount + 1,
        totalPointsEarned: referral.totalPointsEarned + REFERRAL_BONUS_POINTS,
      },
    });

    return { referrerId: referral.referrerId, pointsAwarded: REFERRAL_BONUS_POINTS };
  }

  async validateCode(code: string) {
    const referral = await this.prisma.referral.findFirst({ where: { code: code.toUpperCase() } });
    if (!referral) return { valid: false, reason: 'not_found' };
    if (referral.status !== 'active') return { valid: false, reason: 'inactive' };
    return { valid: true, referrerId: referral.referrerId };
  }

  async deactivate(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { referrerId: userId } });
    if (!referral) throw new Error('referral_not_found');
    if (referral.status !== 'active') throw new Error('already_inactive');

    return this.prisma.referral.update({
      where: { id: referral.id },
      data: { status: 'inactive' },
    });
  }

  async activate(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { referrerId: userId } });
    if (!referral) throw new Error('referral_not_found');
    if (referral.status === 'active') throw new Error('already_active');

    return this.prisma.referral.update({
      where: { id: referral.id },
      data: { status: 'active' },
    });
  }

  async getConversionStats(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { referrerId: userId } });
    if (!referral) return { hasCode: false, code: null, signupCount: 0, rewardedCount: 0, conversionRate: 0, totalPointsEarned: 0 };

    const conversionRate = referral.signupCount > 0
      ? Math.round(referral.rewardedCount / referral.signupCount * 10000) / 100
      : 0;

    return {
      hasCode: true,
      code: referral.code,
      signupCount: referral.signupCount,
      rewardedCount: referral.rewardedCount,
      conversionRate,
      totalPointsEarned: referral.totalPointsEarned,
    };
  }

  async getRewardTimeline(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { referrerId: userId } });
    if (!referral) {
      return { hasCode: false, totalSignups: 0, pendingCount: 0, rewardedCount: 0, rewardRate: 0, totalPointsEarned: 0, signups: [] };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
      orderBy: { createdAt: 'desc' },
    });

    let pendingCount = 0;
    let rewardedCount = 0;
    for (const s of signups) {
      if (s.status === 'rewarded') rewardedCount++;
      else pendingCount++;
    }

    const rewardRate = signups.length > 0
      ? Math.round(rewardedCount / signups.length * 10000) / 100
      : 0;

    return {
      hasCode: true,
      totalSignups: signups.length,
      pendingCount,
      rewardedCount,
      rewardRate,
      totalPointsEarned: referral.totalPointsEarned,
      signups: signups.map((s: any) => ({
        id: s.id,
        status: s.status,
        rewardedAt: s.rewardedAt,
        createdAt: s.createdAt,
      })),
    };
  }

  async getReferralROI(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { referrerId: userId } });
    if (!referral) {
      return { hasCode: false, signupCount: 0, rewardedCount: 0, totalPointsEarned: 0, pointsPerSignup: 0, pointsPerReward: 0, conversionRate: 0 };
    }

    const signups = await this.prisma.referralSignup.findMany({ where: { referralId: referral.id } });
    const rewarded = signups.filter((s: any) => s.status === 'rewarded');
    const pending = signups.filter((s: any) => s.status === 'signed_up');

    const pointsPerSignup = referral.signupCount > 0
      ? Math.round(referral.totalPointsEarned / referral.signupCount)
      : 0;
    const pointsPerReward = referral.rewardedCount > 0
      ? Math.round(referral.totalPointsEarned / referral.rewardedCount)
      : 0;
    const conversionRate = referral.signupCount > 0
      ? Math.round((referral.rewardedCount / referral.signupCount) * 10000) / 100
      : 0;

    let avgConversionTimeMs: number | null = null;
    const conversionTimes: number[] = [];
    for (const s of rewarded) {
      if ((s as any).rewardedAt && s.createdAt) {
        conversionTimes.push(new Date((s as any).rewardedAt).getTime() - new Date(s.createdAt).getTime());
      }
    }
    if (conversionTimes.length > 0) {
      avgConversionTimeMs = Math.round(conversionTimes.reduce((a, b) => a + b, 0) / conversionTimes.length);
    }

    return {
      hasCode: true,
      code: referral.code,
      status: referral.status,
      signupCount: referral.signupCount,
      rewardedCount: referral.rewardedCount,
      pendingCount: pending.length,
      totalPointsEarned: referral.totalPointsEarned,
      pointsPerSignup,
      pointsPerReward,
      conversionRate,
      avgConversionTimeMs,
    };
  }

  async getNetworkGrowth(userId: string) {
    const referral = await this.prisma.referral.findFirst({
      where: { referrerId: userId },
    });
    if (!referral) {
      return {
        hasReferralCode: false,
        totalSignups: 0,
        rewardedSignups: 0,
        pendingSignups: 0,
        conversionRate: 0,
        growthByMonth: [] as Array<{ month: string; signups: number; rewarded: number }>,
        avgSignupsPerMonth: 0,
        streakMonths: 0,
        topMonth: null as { month: string; signups: number } | null,
      };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
      orderBy: { createdAt: 'asc' },
    });

    const rewarded = signups.filter((s: any) => s.status === 'rewarded');
    const pending = signups.filter((s: any) => s.status === 'pending');

    const monthMap = new Map<string, { signups: number; rewarded: number }>();
    for (const s of signups) {
      const d = new Date(s.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const entry = monthMap.get(key) ?? { signups: 0, rewarded: 0 };
      entry.signups++;
      if ((s as any).status === 'rewarded') entry.rewarded++;
      monthMap.set(key, entry);
    }

    const growthByMonth = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));

    const avgSignupsPerMonth = growthByMonth.length > 0
      ? Math.round((signups.length / growthByMonth.length) * 100) / 100
      : 0;

    let streakMonths = 0;
    if (growthByMonth.length > 0) {
      for (let i = growthByMonth.length - 1; i >= 0; i--) {
        if (growthByMonth[i]!.signups > 0) streakMonths++;
        else break;
      }
    }

    const topMonth = growthByMonth.length > 0
      ? growthByMonth.reduce((best, cur) => cur.signups > best.signups ? cur : best)
      : null;

    return {
      hasReferralCode: true,
      totalSignups: signups.length,
      rewardedSignups: rewarded.length,
      pendingSignups: pending.length,
      conversionRate: signups.length > 0
        ? Math.round((rewarded.length / signups.length) * 10000) / 100
        : 0,
      growthByMonth,
      avgSignupsPerMonth,
      streakMonths,
      topMonth: topMonth ? { month: topMonth.month, signups: topMonth.signups } : null,
    };
  }

  async listAll(opts?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = {};
    if (opts?.status) where.status = opts.status;
    return this.prisma.referral.findMany({
      where,
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async listSignups(userId: string) {
    const referral = await this.prisma.referral.findFirst({
      where: { referrerId: userId },
    });
    if (!referral) return [];

    return this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getReferralEffectiveness(userId: string) {
    const referral = await this.prisma.referral.findFirst({
      where: { referrerId: userId },
    });
    if (!referral) {
      return {
        hasReferralCode: false,
        totalSignups: 0,
        totalRewarded: 0,
        conversionRate: 0,
        weeklyBreakdown: [],
        effectivenessScore: 0,
        avgConversionDays: null,
      };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
      orderBy: { createdAt: 'asc' },
    });

    const weeklyMap = new Map<string, { signups: number; rewarded: number }>();
    for (const s of signups) {
      const d = new Date(s.createdAt);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      const entry = weeklyMap.get(key) ?? { signups: 0, rewarded: 0 };
      entry.signups++;
      if ((s as any).rewardedAt) entry.rewarded++;
      weeklyMap.set(key, entry);
    }

    const weeklyBreakdown = Array.from(weeklyMap.entries())
      .map(([week, data]) => ({
        week,
        signups: data.signups,
        rewarded: data.rewarded,
        conversionRate: data.signups > 0
          ? Math.round((data.rewarded / data.signups) * 10000) / 100
          : 0,
      }))
      .sort((a, b) => a.week.localeCompare(b.week));

    const rewardedSignups = signups.filter((s: any) => s.rewardedAt);
    let avgConversionDays: number | null = null;
    if (rewardedSignups.length > 0) {
      const totalDays = rewardedSignups.reduce((sum: number, s: any) => {
        const signupDate = new Date(s.createdAt).getTime();
        const rewardDate = new Date(s.rewardedAt).getTime();
        return sum + (rewardDate - signupDate) / (24 * 60 * 60 * 1000);
      }, 0);
      avgConversionDays = Math.round((totalDays / rewardedSignups.length) * 100) / 100;
    }

    const conversionRate = referral.signupCount > 0
      ? Math.round((referral.rewardedCount / referral.signupCount) * 10000) / 100
      : 0;

    const velocityScore = Math.min(100, signups.length * 10);
    const conversionScore = conversionRate;
    const effectivenessScore = Math.round((velocityScore * 0.4 + conversionScore * 0.6) * 100) / 100;

    return {
      hasReferralCode: true,
      code: referral.code,
      totalSignups: referral.signupCount,
      totalRewarded: referral.rewardedCount,
      conversionRate,
      weeklyBreakdown,
      avgConversionDays,
      effectivenessScore,
      totalPointsEarned: referral.totalPointsEarned,
    };
  }

  async getViralityScore(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { referrerId: userId } });

    if (!referral) {
      return {
        hasReferralCode: false,
        viralCoefficient: 0,
        signupVelocity: 0,
        rewardConversionRate: 0,
        viralityScore: 0,
        viralityLevel: 'none' as const,
        signupsByMonth: [] as Array<{ month: string; count: number }>,
      };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
      orderBy: { createdAt: 'asc' },
    });

    const referredUserIds = signups.map((s: any) => s.referredUserId);
    const secondaryReferrals = referredUserIds.length > 0
      ? await this.prisma.referral.findMany({})
      : [];
    const secondaryCount = secondaryReferrals
      .filter((r: any) => referredUserIds.includes(r.referrerId) && r.signupCount > 0)
      .reduce((s: number, r: any) => s + r.signupCount, 0);

    const viralCoefficient = signups.length > 0
      ? Math.round((secondaryCount / signups.length) * 100) / 100
      : 0;

    const firstSignup = signups[0];
    const lastSignup = signups[signups.length - 1];
    const daySpan = firstSignup && lastSignup
      ? Math.max(1, (new Date(lastSignup.createdAt).getTime() - new Date(firstSignup.createdAt).getTime()) / (24 * 60 * 60 * 1000))
      : 1;
    const signupVelocity = Math.round((signups.length / daySpan) * 100) / 100;

    const rewardConversionRate = referral.signupCount > 0
      ? Math.round((referral.rewardedCount / referral.signupCount) * 10000) / 100
      : 0;

    const velocityScore = Math.min(40, signupVelocity * 20);
    const viralScore = Math.min(30, viralCoefficient * 30);
    const conversionScore = Math.min(30, rewardConversionRate * 0.3);
    const viralityScore = Math.round((velocityScore + viralScore + conversionScore) * 100) / 100;

    const viralityLevel = viralityScore >= 60 ? 'high' as const
      : viralityScore >= 30 ? 'moderate' as const
      : viralityScore > 0 ? 'low' as const
      : 'none' as const;

    const monthMap = new Map<string, number>();
    for (const s of signups) {
      const d = new Date(s.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthMap.set(key, (monthMap.get(key) ?? 0) + 1);
    }
    const signupsByMonth = Array.from(monthMap.entries())
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return {
      hasReferralCode: true,
      viralCoefficient,
      signupVelocity,
      rewardConversionRate,
      viralityScore,
      viralityLevel,
      signupsByMonth,
    };
  }

  async getReferralRetentionAnalysis(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { referrerId: userId } });
    if (!referral) {
      return {
        hasReferralCode: false,
        totalSignups: 0,
        rewardedCount: 0,
        retentionRate: 0,
        avgDaysToReward: 0,
        byMonth: [],
        retentionTrend: 'none' as const,
      };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
      orderBy: { createdAt: 'asc' },
    });

    const rewarded = signups.filter((s) => s.rewardedAt !== null && s.rewardedAt !== undefined);
    const retentionRate = signups.length > 0
      ? Math.round((rewarded.length / signups.length) * 100)
      : 0;

    const daysToReward = rewarded.map((s) => {
      const created = new Date(s.createdAt).getTime();
      const rewardedTime = new Date(s.rewardedAt!).getTime();
      return Math.ceil((rewardedTime - created) / 86400000);
    });
    const avgDaysToReward = daysToReward.length > 0
      ? Math.round(daysToReward.reduce((s, v) => s + v, 0) / daysToReward.length)
      : 0;

    const monthMap = new Map<string, { signups: number; rewarded: number }>();
    for (const s of signups) {
      const d = new Date(s.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const entry = monthMap.get(key) ?? { signups: 0, rewarded: 0 };
      entry.signups++;
      if (s.rewardedAt) entry.rewarded++;
      monthMap.set(key, entry);
    }
    const byMonth = Array.from(monthMap.entries())
      .map(([month, data]) => ({
        month,
        signups: data.signups,
        rewarded: data.rewarded,
        rate: data.signups > 0 ? Math.round((data.rewarded / data.signups) * 100) : 0,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    let retentionTrend: 'improving' | 'declining' | 'stable' | 'none' = 'none';
    if (byMonth.length >= 2) {
      const half = Math.floor(byMonth.length / 2);
      const firstHalf = byMonth.slice(0, half);
      const secondHalf = byMonth.slice(half);
      const avgFirst = firstHalf.reduce((s, m) => s + m.rate, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, m) => s + m.rate, 0) / secondHalf.length;
      retentionTrend = avgSecond > avgFirst * 1.1 ? 'improving'
        : avgSecond < avgFirst * 0.9 ? 'declining'
        : 'stable';
    }

    return {
      hasReferralCode: true,
      totalSignups: signups.length,
      rewardedCount: rewarded.length,
      retentionRate,
      avgDaysToReward,
      byMonth,
      retentionTrend,
    };
  }

  async getReferralChainDepth(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { userId } });
    if (!referral) {
      return {
        hasReferralCode: false,
        totalSignups: 0,
        chainDepth: 0,
        signupsByStatus: [],
        avgSignupsPerDay: 0,
        conversionFunnel: { signed_up: 0, rewarded: 0, rate: 0 },
      };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
    });

    if (signups.length === 0) {
      return {
        hasReferralCode: true,
        totalSignups: 0,
        chainDepth: 0,
        signupsByStatus: [],
        avgSignupsPerDay: 0,
        conversionFunnel: { signed_up: 0, rewarded: 0, rate: 0 },
      };
    }

    const statusMap = new Map<string, number>();
    for (const s of signups) {
      const st = (s as any).status || 'signed_up';
      statusMap.set(st, (statusMap.get(st) || 0) + 1);
    }

    const signedUp = signups.length;
    const rewarded = signups.filter((s: any) => s.rewardedAt !== null).length;

    const sorted = [...signups].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const firstDate = new Date(sorted[0]!.createdAt).getTime();
    const lastDate = new Date(sorted[sorted.length - 1]!.createdAt).getTime();
    const daySpan = Math.max(1, (lastDate - firstDate) / 86400000);
    const avgSignupsPerDay = Number((signups.length / daySpan).toFixed(4));

    let chainDepth = 1;
    for (const s of signups) {
      const childReferral = await this.prisma.referral.findFirst({ where: { userId: (s as any).referredUserId } });
      if (childReferral) {
        const childSignups = await this.prisma.referralSignup.findMany({ where: { referralId: childReferral.id } });
        if (childSignups.length > 0) chainDepth = Math.max(chainDepth, 2);
      }
    }

    return {
      hasReferralCode: true,
      totalSignups: signups.length,
      chainDepth,
      signupsByStatus: Array.from(statusMap.entries()).map(([status, count]) => ({ status, count })),
      avgSignupsPerDay,
      conversionFunnel: {
        signed_up: signedUp,
        rewarded,
        rate: Number((rewarded / signedUp).toFixed(4)),
      },
    };
  }

  async getReferralQualityScore(userId: string) {
    const referral = await this.prisma.referral.findFirst({ where: { userId } });

    if (!referral) {
      return {
        hasReferralCode: false,
        qualityScore: 0,
        totalSignups: 0,
        activeSignups: 0,
        rewardedSignups: 0,
        qualityLevel: 'none' as const,
        breakdown: {
          conversionScore: 0,
          retentionScore: 0,
          volumeScore: 0,
        },
        recommendations: [] as string[],
      };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
    });

    if (signups.length === 0) {
      return {
        hasReferralCode: true,
        qualityScore: 0,
        totalSignups: 0,
        activeSignups: 0,
        rewardedSignups: 0,
        qualityLevel: 'low' as const,
        breakdown: {
          conversionScore: 0,
          retentionScore: 0,
          volumeScore: 0,
        },
        recommendations: ['Share your referral code to start earning rewards'],
      };
    }

    let rewarded = 0;
    let active = 0;
    for (const s of signups) {
      const status = ((s as any).status || '').toLowerCase();
      if (status === 'rewarded' || status === 'completed') rewarded++;
      if (status !== 'expired' && status !== 'cancelled') active++;
    }

    const conversionScore = Math.round((rewarded / signups.length) * 40);
    const retentionScore = Math.round((active / signups.length) * 30);
    const volumeBonus = Math.min(30, signups.length * 3);
    const qualityScore = Math.min(100, conversionScore + retentionScore + volumeBonus);

    const qualityLevel = qualityScore >= 70 ? 'excellent' as const
      : qualityScore >= 40 ? 'good' as const
      : 'low' as const;

    const recommendations: string[] = [];
    if (conversionScore < 15) recommendations.push('Low conversion rate — focus on sharing with engaged users');
    if (retentionScore < 10) recommendations.push('Many signups are inactive — follow up with referred users');
    if (volumeBonus < 10) recommendations.push('Increase referral volume to improve overall quality score');

    return {
      hasReferralCode: true,
      qualityScore,
      totalSignups: signups.length,
      activeSignups: active,
      rewardedSignups: rewarded,
      qualityLevel,
      breakdown: {
        conversionScore,
        retentionScore,
        volumeScore: volumeBonus,
      },
      recommendations,
    };
  }

  async getReferralRevenueAttribution(userId: string) {
    const referral = await this.prisma.referral.findUnique({ where: { userId } });
    if (!referral) {
      return {
        hasReferralCode: false,
        totalSignups: 0,
        activeSignups: 0,
        estimatedRevenue: '0',
        revenuePerSignup: '0',
        attributionLevel: 'none',
        recommendations: [],
      };
    }

    const signups = await this.prisma.referralSignup.findMany({
      where: { referralId: referral.id },
    });

    const activeSignups = signups.filter(s => {
      const status = ((s as any).status || '').toLowerCase();
      return status === 'active' || status === 'converted' || status === 'completed';
    }).length;

    const rewardAmount = (referral as any).rewardAmount ?? BigInt(0);
    const estimatedRevenue = rewardAmount * BigInt(Math.max(1, activeSignups));
    const revenuePerSignup = signups.length > 0
      ? estimatedRevenue / BigInt(signups.length)
      : BigInt(0);

    const attributionLevel = activeSignups >= 10 ? 'high'
      : activeSignups >= 3 ? 'moderate'
      : activeSignups >= 1 ? 'low' : 'none';

    const recommendations: string[] = [];
    if (signups.length === 0) recommendations.push('Share your referral code to start earning rewards');
    if (activeSignups < signups.length * 0.5) recommendations.push('Encourage referred users to complete onboarding');
    if (attributionLevel === 'high') recommendations.push('Strong referral performance — consider ambassador program');

    return {
      hasReferralCode: true,
      totalSignups: signups.length,
      activeSignups,
      estimatedRevenue: estimatedRevenue.toString(),
      revenuePerSignup: revenuePerSignup.toString(),
      attributionLevel,
      recommendations,
    };
  }

  async getReferralNetworkHealth(userId: string) {
    const referral = await this.prisma.referral.findUnique({ where: { userId } });
    if (!referral) {
      return {
        hasReferralCode: false,
        healthLevel: 'no_data' as const,
        healthScore: 0,
        totalSignups: 0,
        activeSignups: 0,
        conversionRate: 0,
        recommendations: [],
      };
    }

    const signups = await this.prisma.referralSignup.findMany({ where: { referralId: referral.id } });

    if (signups.length === 0) {
      return {
        hasReferralCode: true,
        healthLevel: 'inactive' as const,
        healthScore: 0,
        totalSignups: 0,
        activeSignups: 0,
        conversionRate: 0,
        recommendations: ['Share your referral code to start building your network'],
      };
    }

    const activeStatuses = ['active', 'converted', 'completed', 'ACTIVE', 'CONVERTED', 'COMPLETED'];
    const activeSignups = signups.filter(s => activeStatuses.includes(s.status)).length;
    const conversionRate = Math.round((activeSignups / signups.length) * 100);

    const now = Date.now();
    const recentSignups = signups.filter(s => now - new Date(s.createdAt).getTime() < 30 * 86400000).length;

    let healthScore = 0;
    if (activeSignups > 10) healthScore += 30;
    else if (activeSignups > 5) healthScore += 20;
    else if (activeSignups > 0) healthScore += 10;

    if (conversionRate > 80) healthScore += 30;
    else if (conversionRate > 50) healthScore += 20;
    else if (conversionRate > 20) healthScore += 10;

    if (recentSignups > 3) healthScore += 25;
    else if (recentSignups > 0) healthScore += 15;

    healthScore = Math.min(100, healthScore);
    const healthLevel = healthScore >= 60 ? 'thriving' : healthScore >= 30 ? 'growing' : 'stagnant';

    const recommendations: string[] = [];
    if (recentSignups === 0) recommendations.push('No recent signups — consider resharing your code');
    if (conversionRate < 50) recommendations.push('Low conversion rate — follow up with pending referrals');
    if (healthLevel === 'thriving') recommendations.push('Great network health — keep sharing!');

    return {
      hasReferralCode: true,
      healthLevel,
      healthScore,
      totalSignups: signups.length,
      activeSignups,
      conversionRate,
      recentSignups,
      recommendations,
    };
  }

  async getReferralConversionPipeline(userId: string) {
    const referrals = await this.prisma.referral.findMany({ where: { userId } });

    if (referrals.length === 0) {
      return {
        totalReferrals: 0,
        pipelineScore: 0,
        pipelineLevel: 'no_data' as const,
        stages: { invited: 0, signedUp: 0, active: 0, rewarded: 0 },
        recommendations: [] as string[],
      };
    }

    let invited = 0;
    let signedUp = 0;
    let active = 0;
    let rewarded = 0;

    for (const r of referrals) {
      const status = (r as any).status ?? 'active';
      const sc = (r as any).signupCount ?? 0;
      const rc = (r as any).rewardedCount ?? 0;

      invited++;
      if (sc > 0) signedUp += sc;
      if (status === 'active' || status === 'ACTIVE') active++;
      if (rc > 0) rewarded += rc;
    }

    const signupRate = invited > 0 ? Math.round((signedUp / invited) * 100) : 0;
    const rewardRate = signedUp > 0 ? Math.round((rewarded / signedUp) * 100) : 0;

    let pipelineScore = 0;
    if (signupRate >= 50) pipelineScore += 30;
    else if (signupRate >= 20) pipelineScore += 15;
    if (rewardRate >= 50) pipelineScore += 30;
    else if (rewardRate >= 20) pipelineScore += 15;
    if (active >= 3) pipelineScore += 20;
    else if (active >= 1) pipelineScore += 10;
    if (referrals.length >= 5) pipelineScore += 20;
    else if (referrals.length >= 2) pipelineScore += 10;
    pipelineScore = Math.min(100, pipelineScore);

    const pipelineLevel = pipelineScore >= 70 ? 'strong'
      : pipelineScore >= 40 ? 'developing' : 'nascent';

    const recommendations: string[] = [];
    if (signedUp === 0) recommendations.push('No sign-ups yet — share referral links more broadly');
    if (signupRate < 20) recommendations.push('Low sign-up rate — consider offering incentives');
    if (pipelineLevel === 'strong') recommendations.push('Referral pipeline is performing well');

    return {
      totalReferrals: referrals.length,
      signupRate,
      rewardRate,
      pipelineScore,
      pipelineLevel,
      stages: { invited, signedUp, active, rewarded },
      recommendations,
    };
  }
}
