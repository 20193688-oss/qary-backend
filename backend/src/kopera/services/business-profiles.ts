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

  async getDueDiligenceReport(userId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    const fields = ['taxId', 'taxIdType', 'taxIdCountry', 'legalName', 'tradeName',
      'incorporationDate', 'economicActivity', 'ciiu', 'fiscalAddress',
      'legalRepName', 'legalRepDocType', 'legalRepDocNumber'] as const;
    const filledCount = fields.filter((f) => !!(profile as any)[f]).length;
    const completeness = Math.round((filledCount / fields.length) * 100);

    const checks: Array<{ area: string; status: string; detail: string }> = [];

    checks.push({
      area: 'identity',
      status: profile.taxId && profile.taxIdType && profile.taxIdCountry ? 'pass' : 'fail',
      detail: profile.taxId ? `${profile.taxIdType} in ${profile.taxIdCountry}` : 'Tax ID missing',
    });

    checks.push({
      area: 'legal_representation',
      status: profile.legalRepName && profile.legalRepDocNumber ? 'pass' : 'fail',
      detail: profile.legalRepName ? `${profile.legalRepName}` : 'Legal representative not set',
    });

    checks.push({
      area: 'verification',
      status: profile.status === 'APPROVED' ? 'pass' : 'pending',
      detail: `Status: ${profile.status}`,
    });

    const hasScreening = !!(profile as any).lastScreeningAt;
    checks.push({
      area: 'screening',
      status: hasScreening ? 'pass' : 'fail',
      detail: hasScreening ? `Last screened: ${(profile as any).lastScreeningAt}` : 'No screening performed',
    });

    const riskScore = profile.riskScore ?? null;
    checks.push({
      area: 'risk_assessment',
      status: riskScore !== null ? 'pass' : 'fail',
      detail: riskScore !== null ? `Risk score: ${riskScore}` : 'No risk assessment',
    });

    const passedCount = checks.filter((c) => c.status === 'pass').length;
    const overallScore = Math.round((passedCount / checks.length) * 100);
    const blockers = checks.filter((c) => c.status === 'fail').map((c) => c.area);
    const overallStatus = blockers.length === 0 ? 'approved' : blockers.length <= 2 ? 'needs_attention' : 'incomplete';

    return {
      userId,
      profileCompleteness: completeness,
      overallScore,
      overallStatus,
      checks,
      blockers,
      riskScore,
      status: profile.status,
    };
  }

  async getOnboardingTimeline(userId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    const steps: Array<{ step: string; status: string; completedAt: Date | null }> = [];

    steps.push({
      step: 'registration',
      status: 'completed',
      completedAt: profile.createdAt,
    });

    const hasIdentity = !!(profile.taxId && profile.taxIdType && profile.taxIdCountry);
    steps.push({
      step: 'identity_documents',
      status: hasIdentity ? 'completed' : 'pending',
      completedAt: hasIdentity ? profile.createdAt : null,
    });

    const hasLegalRep = !!(profile.legalRepName && profile.legalRepDocNumber);
    steps.push({
      step: 'legal_representative',
      status: hasLegalRep ? 'completed' : 'pending',
      completedAt: hasLegalRep ? profile.createdAt : null,
    });

    const hasScreening = !!(profile as any).lastScreeningAt;
    steps.push({
      step: 'screening',
      status: hasScreening ? 'completed' : 'pending',
      completedAt: hasScreening ? (profile as any).lastScreeningAt : null,
    });

    steps.push({
      step: 'verification',
      status: profile.status === 'APPROVED' ? 'completed' : profile.status === 'REJECTED' ? 'rejected' : 'pending',
      completedAt: profile.verifiedAt ?? null,
    });

    const completedSteps = steps.filter((s) => s.status === 'completed').length;
    const progressPercent = Math.round((completedSteps / steps.length) * 100);
    const currentStep = steps.find((s) => s.status === 'pending')?.step ?? (steps.every((s) => s.status === 'completed') ? 'done' : steps.find((s) => s.status === 'rejected')?.step ?? 'unknown');

    return {
      userId,
      status: profile.status,
      progressPercent,
      completedSteps,
      totalSteps: steps.length,
      currentStep,
      steps,
      createdAt: profile.createdAt,
      verifiedAt: profile.verifiedAt,
    };
  }

  async getRiskProfile(userId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    const fields = ['taxId', 'taxIdType', 'taxIdCountry', 'legalName', 'tradeName',
      'incorporationDate', 'economicActivity', 'ciiu', 'fiscalAddress',
      'legalRepName', 'legalRepDocType', 'legalRepDocNumber'] as const;
    const filledCount = fields.filter(f => !!(profile as any)[f]).length;
    const completeness = Math.round((filledCount / fields.length) * 100);

    const riskScore = profile.riskScore ?? null;
    const reputationScore = (profile as any).reputationScore ?? null;
    const complianceScore = (profile as any).complianceScore ?? null;
    const hasScreening = !!(profile as any).lastScreeningAt;
    const isVerified = profile.status === 'APPROVED';

    const factors: Array<{ factor: string; status: string; weight: number; score: number }> = [];

    factors.push({ factor: 'verification', status: isVerified ? 'pass' : 'fail', weight: 25, score: isVerified ? 25 : 0 });
    factors.push({ factor: 'completeness', status: completeness >= 80 ? 'pass' : completeness >= 50 ? 'partial' : 'fail', weight: 20, score: Math.round(completeness * 0.2) });
    factors.push({ factor: 'screening', status: hasScreening ? 'pass' : 'fail', weight: 20, score: hasScreening ? 20 : 0 });
    factors.push({ factor: 'risk_score', status: riskScore !== null ? (riskScore <= 50 ? 'pass' : 'warning') : 'unknown', weight: 20, score: riskScore !== null ? Math.round((100 - Math.min(riskScore, 100)) * 0.2) : 0 });
    factors.push({ factor: 'compliance', status: complianceScore !== null ? (complianceScore >= 70 ? 'pass' : 'warning') : 'unknown', weight: 15, score: complianceScore !== null ? Math.round(Math.min(complianceScore, 100) * 0.15) : 0 });

    const overallScore = factors.reduce((sum, f) => sum + f.score, 0);
    const riskLevel = overallScore >= 80 ? 'low' : overallScore >= 50 ? 'medium' : 'high';

    return {
      userId,
      status: profile.status,
      overallScore,
      riskLevel,
      completeness,
      riskScore,
      reputationScore,
      complianceScore,
      hasScreening,
      factors,
    };
  }

  async getComplianceGapAnalysis(userId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    const p = profile as any;
    const requiredFields = [
      { field: 'taxId', label: 'Tax ID', category: 'identity' },
      { field: 'taxIdType', label: 'Tax ID Type', category: 'identity' },
      { field: 'taxIdCountry', label: 'Tax ID Country', category: 'identity' },
      { field: 'legalName', label: 'Legal Name', category: 'registration' },
      { field: 'incorporationDate', label: 'Incorporation Date', category: 'registration' },
      { field: 'economicActivity', label: 'Economic Activity', category: 'registration' },
      { field: 'ciiu', label: 'CIIU Code', category: 'registration' },
      { field: 'fiscalAddress', label: 'Fiscal Address', category: 'address' },
      { field: 'legalRepName', label: 'Legal Rep Name', category: 'representative' },
      { field: 'legalRepDocType', label: 'Legal Rep Doc Type', category: 'representative' },
      { field: 'legalRepDocNumber', label: 'Legal Rep Doc Number', category: 'representative' },
    ];

    const gaps: { field: string; label: string; category: string; severity: string }[] = [];
    const categoryStatus = new Map<string, { total: number; filled: number }>();

    for (const rf of requiredFields) {
      const cat = categoryStatus.get(rf.category) ?? { total: 0, filled: 0 };
      cat.total++;
      if (p[rf.field]) {
        cat.filled++;
      } else {
        const severity = ['taxId', 'legalName', 'legalRepName'].includes(rf.field) ? 'critical' : 'important';
        gaps.push({ field: rf.field, label: rf.label, category: rf.category, severity });
      }
      categoryStatus.set(rf.category, cat);
    }

    const isVerified = profile.status === 'APPROVED';
    const hasScreening = !!p.lastScreeningAt;
    if (!isVerified) gaps.push({ field: 'verification', label: 'Profile Verification', category: 'verification', severity: 'critical' });
    if (!hasScreening) gaps.push({ field: 'screening', label: 'AML Screening', category: 'screening', severity: 'critical' });

    const byCategory = Array.from(categoryStatus.entries()).map(([category, data]) => ({
      category,
      filled: data.filled,
      total: data.total,
      completeness: Math.round((data.filled / data.total) * 100),
    }));

    const criticalGaps = gaps.filter(g => g.severity === 'critical').length;
    const totalGaps = gaps.length;
    const complianceScore = Math.round(((requiredFields.length + 2 - totalGaps) / (requiredFields.length + 2)) * 100);

    const readiness = complianceScore >= 90 ? 'ready'
      : complianceScore >= 70 ? 'near_ready'
      : complianceScore >= 40 ? 'in_progress'
      : 'not_started';

    return {
      userId,
      status: profile.status,
      complianceScore,
      readiness,
      totalGaps,
      criticalGaps,
      gaps,
      byCategory,
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
