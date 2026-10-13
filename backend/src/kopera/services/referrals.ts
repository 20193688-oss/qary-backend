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
}
