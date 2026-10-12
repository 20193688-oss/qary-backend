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
