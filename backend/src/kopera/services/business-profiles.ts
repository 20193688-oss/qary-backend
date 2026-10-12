import type { PrismaClient, Prisma } from '@prisma/client';

export class BusinessProfileService {
  constructor(private prisma: PrismaClient) {}

  async create(userId: string, data: {
    taxId: string;
    taxIdType: string;
    taxIdCountry: string;
    legalName?: string;
    tradeName?: string;
    incorporationDate?: Date;
    economicActivity?: string;
    ciiu?: string;
    fiscalAddress?: Prisma.InputJsonValue;
    legalRepName?: string;
    legalRepDocType?: string;
    legalRepDocNumber?: string;
  }) {
    const existing = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (existing) throw new Error('profile_already_exists');

    return this.prisma.businessProfile.create({
      data: { userId, ...data },
    });
  }

  async getByUser(userId: string) {
    return this.prisma.businessProfile.findUnique({ where: { userId } });
  }

  async update(userId: string, data: {
    legalName?: string;
    tradeName?: string;
    economicActivity?: string;
    ciiu?: string;
    fiscalAddress?: Prisma.InputJsonValue;
    legalRepName?: string;
    legalRepDocType?: string;
    legalRepDocNumber?: string;
  }) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    return this.prisma.businessProfile.update({
      where: { userId },
      data,
    });
  }

  async verify(userId: string, reviewedBy: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');
    if (profile.status === 'APPROVED') throw new Error('already_verified');

    return this.prisma.businessProfile.update({
      where: { userId },
      data: { status: 'APPROVED', verifiedAt: new Date() },
    });
  }

  async runScreening(userId: string, data: {
    riskScore?: number;
    reputationScore?: number;
    complianceScore?: number;
    screeningReport?: object;
  }) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    const updateData: Record<string, unknown> = { lastScreeningAt: new Date() };
    if (data.riskScore !== undefined) updateData.riskScore = data.riskScore;
    if (data.reputationScore !== undefined) updateData.reputationScore = data.reputationScore;
    if (data.complianceScore !== undefined) updateData.complianceScore = data.complianceScore;
    if (data.screeningReport !== undefined) updateData.screeningReport = data.screeningReport;

    return this.prisma.businessProfile.update({
      where: { userId },
      data: updateData,
    });
  }

  async getVerificationStatus(userId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    return {
      status: profile.status,
      verifiedAt: profile.verifiedAt,
      rejectedReason: profile.rejectedReason,
      riskScore: profile.riskScore,
      reputationScore: (profile as any).reputationScore ?? null,
      complianceScore: (profile as any).complianceScore ?? null,
      lastScreeningAt: (profile as any).lastScreeningAt ?? null,
    };
  }

  async getProfileCompleteness(userId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    const fields = [
      { name: 'taxId', filled: !!profile.taxId },
      { name: 'taxIdType', filled: !!profile.taxIdType },
      { name: 'taxIdCountry', filled: !!profile.taxIdCountry },
      { name: 'legalName', filled: !!profile.legalName },
      { name: 'tradeName', filled: !!profile.tradeName },
      { name: 'incorporationDate', filled: !!profile.incorporationDate },
      { name: 'economicActivity', filled: !!profile.economicActivity },
      { name: 'ciiu', filled: !!profile.ciiu },
      { name: 'fiscalAddress', filled: !!profile.fiscalAddress },
      { name: 'legalRepName', filled: !!profile.legalRepName },
      { name: 'legalRepDocType', filled: !!profile.legalRepDocType },
      { name: 'legalRepDocNumber', filled: !!profile.legalRepDocNumber },
    ];

    const filledCount = fields.filter(f => f.filled).length;
    const completenessPercent = Math.round((filledCount / fields.length) * 100);

    return {
      completenessPercent,
      filledFields: filledCount,
      totalFields: fields.length,
      missingFields: fields.filter(f => !f.filled).map(f => f.name),
      fields,
      status: profile.status,
    };
  }

  async getComplianceReadiness(userId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    const checks = [
      { name: 'tax_id', passed: !!profile.taxId },
      { name: 'legal_name', passed: !!profile.legalName },
      { name: 'legal_rep', passed: !!(profile.legalRepName && profile.legalRepDocNumber) },
      { name: 'fiscal_address', passed: !!profile.fiscalAddress },
      { name: 'verification', passed: profile.status === 'APPROVED' },
      { name: 'screening', passed: !!(profile as any).lastScreeningAt },
      { name: 'risk_score', passed: profile.riskScore !== null && profile.riskScore !== undefined },
    ];

    const passedCount = checks.filter((c) => c.passed).length;
    const readinessPercent = Math.round((passedCount / checks.length) * 100);
    const isReady = checks.every((c) => c.passed);
    const blockers = checks.filter((c) => !c.passed).map((c) => c.name);

    return {
      isReady,
      readinessPercent,
      passedChecks: passedCount,
      totalChecks: checks.length,
      blockers,
      checks,
      status: profile.status,
      riskScore: profile.riskScore,
    };
  }

  async reject(userId: string, reason: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    return this.prisma.businessProfile.update({
      where: { userId },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
  }
}
