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

  async getEngagementProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    const u = user as any;

    const now = Date.now();
    const accountAgeDays = Math.floor((now - new Date(u.createdAt).getTime()) / 86400000);
    const daysSinceLastLogin = u.lastLoginAt
      ? Math.floor((now - new Date(u.lastLoginAt).getTime()) / 86400000)
      : accountAgeDays;

    const completenessChecks = [
      { field: 'name', filled: !!u.name },
      { field: 'phone', filled: !!u.phone },
      { field: 'avatarUrl', filled: !!u.avatarUrl },
      { field: 'mfaEnabled', filled: !!u.mfaEnabled },
      { field: 'kycStatus', filled: u.kycStatus === 'VERIFIED' },
      { field: 'locale', filled: !!u.locale },
      { field: 'timezone', filled: !!u.timezone },
    ];
    const completedFields = completenessChecks.filter(c => c.filled).length;
    const profileCompleteness = Math.round((completedFields / completenessChecks.length) * 100);

    const sessions = await this.prisma.userSession.findMany({ where: { userId } });
    const distinctDevices = new Set(sessions.map((s: any) => s.deviceId)).size;
    const loginCount = sessions.length;

    let recencyScore = 0;
    if (daysSinceLastLogin <= 1) recencyScore = 100;
    else if (daysSinceLastLogin <= 7) recencyScore = 80;
    else if (daysSinceLastLogin <= 30) recencyScore = 50;
    else if (daysSinceLastLogin <= 90) recencyScore = 20;

    const loginsPerMonth = accountAgeDays > 0
      ? Math.round((loginCount / accountAgeDays) * 30 * 10) / 10
      : loginCount;

    const engagementScore = Math.round(
      0.35 * recencyScore +
      0.30 * profileCompleteness +
      0.20 * Math.min(100, loginsPerMonth * 10) +
      0.15 * Math.min(100, distinctDevices * 33)
    );

    const engagementLevel = engagementScore >= 70 ? 'highly_engaged'
      : engagementScore >= 45 ? 'engaged'
      : engagementScore >= 20 ? 'casual'
      : 'dormant';

    return {
      engagementScore,
      engagementLevel,
      profileCompleteness,
      completenessChecks: completenessChecks.map(c => ({ field: c.field, filled: c.filled })),
      accountAgeDays,
      daysSinceLastLogin,
      loginCount,
      loginsPerMonth,
      distinctDevices,
      recencyScore,
    };
  }

  async getAccountMaturityReport(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    const accountAgeDays = Math.ceil((Date.now() - new Date(user.createdAt).getTime()) / 86400000);

    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    const loans = await this.prisma.loan.findMany({ where: { userId } });
    const subs = await this.prisma.subscription.findMany({ where: { userId } });
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });

    const features = {
      hasWallet: wallets.length > 0,
      hasLoan: loans.length > 0,
      hasSubscription: subs.length > 0,
      hasCard: cards.length > 0,
      hasMfa: user.mfaEnabled === true,
      hasVerifiedEmail: user.emailVerified === true,
    };

    const featureCount = Object.values(features).filter(Boolean).length;
    const totalFeatures = Object.keys(features).length;
    const adoptionRate = Math.round((featureCount / totalFeatures) * 100);

    let maturityLevel: 'new' | 'developing' | 'established' | 'mature';
    if (accountAgeDays < 30 && featureCount <= 2) maturityLevel = 'new';
    else if (accountAgeDays < 90 || featureCount <= 3) maturityLevel = 'developing';
    else if (featureCount <= 4) maturityLevel = 'established';
    else maturityLevel = 'mature';

    const totalBalance = wallets.reduce((s, w) => s + Number(w.balance), 0);

    return {
      accountAgeDays,
      features,
      featureAdoption: featureCount,
      totalFeatures,
      adoptionRate,
      maturityLevel,
      totalWalletBalance: totalBalance.toString(),
      activeLoans: loans.filter((l) => l.status === 'DISBURSED').length,
      activeSubscriptions: subs.filter((s) => s.status === 'active').length,
      totalCards: cards.length,
    };
  }

  async getAccountCompleteness(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    const fields: { field: string; completed: boolean }[] = [];
    let completed = 0;
    const checks = [
      { field: 'email', value: (user as any).email },
      { field: 'phone', value: (user as any).phone },
      { field: 'firstName', value: (user as any).firstName },
      { field: 'lastName', value: (user as any).lastName },
      { field: 'dateOfBirth', value: (user as any).dateOfBirth },
      { field: 'country', value: (user as any).country },
      { field: 'mfaEnabled', value: (user as any).mfaEnabled },
      { field: 'pinHash', value: (user as any).pinHash },
    ];

    for (const c of checks) {
      const isDone = c.value !== null && c.value !== undefined && c.value !== '' && c.value !== false;
      fields.push({ field: c.field, completed: isDone });
      if (isDone) completed++;
    }

    const totalFields = checks.length;
    const completenessPercent = Number(((completed / totalFields) * 100).toFixed(1));

    let level: string;
    if (completenessPercent >= 90) level = 'complete';
    else if (completenessPercent >= 60) level = 'mostly_complete';
    else if (completenessPercent >= 30) level = 'partial';
    else level = 'minimal';

    const missing = fields.filter(f => !f.completed).map(f => f.field);

    return {
      userId,
      completedFields: completed,
      totalFields,
      completenessPercent,
      level,
      fields,
      missingFields: missing,
    };
  }

  async getProfileRiskIndicators(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    const indicators: { indicator: string; severity: 'high' | 'medium' | 'low'; detail: string }[] = [];

    if (!(user as any).mfaEnabled) {
      indicators.push({ indicator: 'no_mfa', severity: 'high', detail: 'Multi-factor authentication is not enabled' });
    }

    if (!(user as any).emailVerified && !(user as any).email) {
      indicators.push({ indicator: 'no_verified_email', severity: 'high', detail: 'No verified email address on file' });
    }

    if (!(user as any).pinHash) {
      indicators.push({ indicator: 'no_pin', severity: 'medium', detail: 'Transaction PIN is not set' });
    }

    const accountAge = Date.now() - new Date(user.createdAt).getTime();
    if (accountAge < 7 * 86400000) {
      indicators.push({ indicator: 'new_account', severity: 'low', detail: 'Account is less than 7 days old' });
    }

    if ((user as any).status === 'suspended' || (user as any).status === 'deactivated') {
      indicators.push({ indicator: 'account_inactive', severity: 'high', detail: `Account status is ${(user as any).status}` });
    }

    if (!(user as any).firstName && !(user as any).lastName) {
      indicators.push({ indicator: 'incomplete_identity', severity: 'medium', detail: 'Name information is missing' });
    }

    const highCount = indicators.filter(i => i.severity === 'high').length;
    const mediumCount = indicators.filter(i => i.severity === 'medium').length;
    const riskScore = Math.min(100, highCount * 30 + mediumCount * 15);
    const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : 'low';

    const recommendations: string[] = [];
    if (highCount > 0) recommendations.push('Address high-severity indicators immediately');
    if (indicators.some(i => i.indicator === 'no_mfa')) recommendations.push('Enable MFA for account security');
    if (indicators.some(i => i.indicator === 'no_pin')) recommendations.push('Set a transaction PIN for payment authorization');

    return {
      userId,
      totalIndicators: indicators.length,
      riskScore,
      riskLevel,
      indicators,
      recommendations,
    };
  }

  async getAccountTrustScore(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    let trustScore = 0;
    const factors: Array<{ factor: string; score: number; status: string }> = [];

    const emailVerified = !!(user as any).emailVerified || !!(user as any).emailVerifiedAt;
    factors.push({ factor: 'email_verified', score: emailVerified ? 20 : 0, status: emailVerified ? 'passed' : 'missing' });
    trustScore += emailVerified ? 20 : 0;

    const phoneVerified = !!(user as any).phoneVerified || !!(user as any).phoneVerifiedAt;
    factors.push({ factor: 'phone_verified', score: phoneVerified ? 15 : 0, status: phoneVerified ? 'passed' : 'missing' });
    trustScore += phoneVerified ? 15 : 0;

    const mfaEnabled = !!(user as any).mfaEnabled;
    factors.push({ factor: 'mfa_enabled', score: mfaEnabled ? 20 : 0, status: mfaEnabled ? 'passed' : 'missing' });
    trustScore += mfaEnabled ? 20 : 0;

    const pinSet = !!(user as any).pin || !!(user as any).pinHash;
    factors.push({ factor: 'pin_set', score: pinSet ? 10 : 0, status: pinSet ? 'passed' : 'missing' });
    trustScore += pinSet ? 10 : 0;

    const accountAge = Date.now() - new Date((user as any).createdAt || Date.now()).getTime();
    const ageMonths = Math.floor(accountAge / (30 * 86400000));
    const ageScore = Math.min(20, ageMonths * 2);
    factors.push({ factor: 'account_age', score: ageScore, status: `${ageMonths} months` });
    trustScore += ageScore;

    const profileComplete = !!(user as any).firstName && !!(user as any).lastName;
    factors.push({ factor: 'profile_complete', score: profileComplete ? 15 : 0, status: profileComplete ? 'passed' : 'incomplete' });
    trustScore += profileComplete ? 15 : 0;

    trustScore = Math.min(100, trustScore);
    const trustLevel = trustScore >= 75 ? 'high' : trustScore >= 40 ? 'moderate' : 'low';

    const recommendations: string[] = [];
    for (const f of factors) {
      if (f.status === 'missing' || f.status === 'incomplete') {
        recommendations.push(`Complete ${f.factor.replace(/_/g, ' ')} to improve trust score`);
      }
    }

    return {
      userId,
      trustScore,
      trustLevel,
      factors,
      recommendations,
    };
  }
}
