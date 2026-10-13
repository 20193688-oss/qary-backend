import type { PrismaClient } from '@prisma/client';

export class UserProfileService {
  constructor(private prisma: PrismaClient) {}

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({ where: { id: userId } });
  }

  async updateProfile(userId: string, data: {
    name?: string;
    phone?: string;
    locale?: string;
    timezone?: string;
    country?: string;
    preferredCurrency?: string;
  }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  async enableMfa(userId: string, secret: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (user.mfaEnabled) throw new Error('mfa_already_enabled');

    return this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: secret, mfaEnabled: true },
    });
  }

  async disableMfa(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (!user.mfaEnabled) throw new Error('mfa_not_enabled');

    return this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaEnabled: false },
    });
  }

  async setPin(userId: string, pinHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { pinHash },
    });
  }

  async deactivateAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (user.status === 'DEACTIVATED') throw new Error('already_deactivated');

    return this.prisma.user.update({
      where: { id: userId },
      data: { status: 'DEACTIVATED' },
    });
  }

  async getAccountOverview(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    const profileFields = ['name', 'phone', 'locale', 'timezone', 'country', 'preferredCurrency'] as const;
    const filledFields = profileFields.filter((f) => !!(user as any)[f]);
    const completionPercent = Math.round((filledFields.length / profileFields.length) * 100);
    const accountAgeDays = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24));

    const securityFeatures = {
      mfaEnabled: user.mfaEnabled,
      pinSet: !!(user as any).pinHash,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified ?? false,
    };
    const securityScore = Object.values(securityFeatures).filter(Boolean).length;

    return {
      accountType: user.accountType ?? 'PERSONAL',
      status: user.status,
      accountAgeDays,
      completionPercent,
      missingFields: profileFields.filter((f) => !(user as any)[f]),
      securityFeatures,
      securityScore,
      maxSecurityScore: Object.keys(securityFeatures).length,
    };
  }

  async getAccountHealthReport(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    const profileFields = ['name', 'phone', 'locale', 'timezone', 'country', 'preferredCurrency'] as const;
    const filledFields = profileFields.filter((f) => !!(user as any)[f]);
    const profileCompleteness = Math.round((filledFields.length / profileFields.length) * 100);

    const securityChecks = {
      mfaEnabled: !!user.mfaEnabled,
      pinSet: !!(user as any).pinHash,
      emailVerified: !!user.emailVerified,
      phoneVerified: !!(user.phoneVerified ?? false),
    };
    const securityScore = Object.values(securityChecks).filter(Boolean).length;
    const maxSecurityScore = Object.keys(securityChecks).length;
    const securityPercent = Math.round((securityScore / maxSecurityScore) * 100);

    const accountAgeDays = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24));

    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    const activeWallets = wallets.filter((w: any) => w.status === 'ACTIVE');
    let totalBalance = BigInt(0);
    for (const w of activeWallets) totalBalance += w.balance;

    const recentTxns = await this.prisma.transaction.findMany({ where: { userId } });
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    let recentActivityCount = 0;
    for (const t of recentTxns) {
      if (new Date(t.createdAt).getTime() >= thirtyDaysAgo) recentActivityCount++;
    }

    const recommendations: string[] = [];
    if (profileCompleteness < 100) {
      const missing = profileFields.filter((f) => !(user as any)[f]);
      recommendations.push(`Complete profile: add ${missing.join(', ')}`);
    }
    if (!securityChecks.mfaEnabled) recommendations.push('Enable two-factor authentication');
    if (!securityChecks.pinSet) recommendations.push('Set a transaction PIN');
    if (!securityChecks.phoneVerified) recommendations.push('Verify your phone number');
    if (activeWallets.length === 0) recommendations.push('Create your first wallet');
    if (recentActivityCount === 0 && accountAgeDays > 7) recommendations.push('Make a transaction to keep your account active');

    const overallScore = Math.round((profileCompleteness * 0.3 + securityPercent * 0.4 + Math.min(recentActivityCount * 10, 100) * 0.3));

    let healthGrade: string;
    if (overallScore >= 90) healthGrade = 'EXCELLENT';
    else if (overallScore >= 70) healthGrade = 'GOOD';
    else if (overallScore >= 50) healthGrade = 'FAIR';
    else healthGrade = 'NEEDS_ATTENTION';

    return {
      overallScore,
      healthGrade,
      profileCompleteness,
      securityPercent,
      securityChecks,
      accountAgeDays,
      walletCount: activeWallets.length,
      totalBalance,
      recentActivityCount,
      recommendations,
    };
  }

  async upgradeToBusinessAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (user.accountType === 'BUSINESS') throw new Error('already_business');

    return this.prisma.user.update({
      where: { id: userId },
      data: { accountType: 'BUSINESS' },
    });
  }

  async getSecurityScorecard(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    const checks = [
      { item: 'email_verified', passed: !!user.emailVerifiedAt, weight: 20 },
      { item: 'mfa_enabled', passed: !!user.mfaEnabled, weight: 30 },
      { item: 'pin_set', passed: !!(user as any).pin, weight: 15 },
      { item: 'phone_added', passed: !!(user as any).phone, weight: 10 },
      { item: 'name_set', passed: !!(user as any).name, weight: 5 },
    ];

    const accountAgeDays = Math.round(
      (Date.now() - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000)
    );
    if (accountAgeDays >= 30) {
      checks.push({ item: 'account_age_30d', passed: true, weight: 10 });
    } else {
      checks.push({ item: 'account_age_30d', passed: false, weight: 10 });
    }

    const activeSessions = await this.prisma.userSession.findMany({
      where: { userId, revokedAt: null },
    });
    const hasReasonableSessions = activeSessions.length <= 5;
    checks.push({ item: 'session_count_reasonable', passed: hasReasonableSessions, weight: 10 });

    const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
    const earnedWeight = checks.filter(c => c.passed).reduce((s, c) => s + c.weight, 0);
    const score = Math.round((earnedWeight / totalWeight) * 100);

    const level = score >= 80 ? 'strong' : score >= 50 ? 'moderate' : 'weak';

    return {
      score,
      level,
      accountAgeDays,
      activeSessions: activeSessions.length,
      checklist: checks.map(c => ({ item: c.item, passed: c.passed })),
      passedChecks: checks.filter(c => c.passed).length,
      totalChecks: checks.length,
    };
  }
}
