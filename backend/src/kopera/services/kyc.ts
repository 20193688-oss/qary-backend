import type { PrismaClient, Prisma } from '@prisma/client';

export class KycService {
  constructor(private prisma: PrismaClient) {}

  async start(userId: string, data: {
    documentType: string;
    documentNumber: string;
    documentCountry: string;
    firstName: string;
    lastName: string;
    dateOfBirth?: Date;
    nationality?: string;
    address?: Prisma.InputJsonValue;
  }) {
    return this.prisma.kycProfile.upsert({
      where: { userId },
      update: {
        documentType: data.documentType as any,
        documentNumber: data.documentNumber,
        documentCountry: data.documentCountry.toUpperCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        dateOfBirth: data.dateOfBirth,
        nationality: data.nationality?.toUpperCase(),
        address: data.address,
        status: 'IN_REVIEW',
      },
      create: {
        userId,
        documentType: data.documentType as any,
        documentNumber: data.documentNumber,
        documentCountry: data.documentCountry.toUpperCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        dateOfBirth: data.dateOfBirth,
        nationality: data.nationality?.toUpperCase(),
        address: data.address,
        status: 'IN_REVIEW',
      },
    });
  }

  async getByUser(userId: string) {
    return this.prisma.kycProfile.findUnique({ where: { userId } });
  }

  async listAll(opts?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = {};
    if (opts?.status) where.status = opts.status;
    return this.prisma.kycProfile.findMany({
      where,
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async approve(userId: string, reviewedBy: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');
    if (profile.status === 'APPROVED') throw new Error('already_approved');

    return this.prisma.kycProfile.update({
      where: { userId },
      data: {
        status: 'APPROVED',
        verifiedAt: new Date(),
        reviewedBy,
        pepCheck: true,
        sanctionsCheck: true,
      },
    });
  }

  async reject(userId: string, reason: string, reviewedBy: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    return this.prisma.kycProfile.update({
      where: { userId },
      data: {
        status: 'REJECTED',
        rejectedReason: reason,
        reviewedBy,
      },
    });
  }

  async uploadDocumentUrls(userId: string, data: {
    documentFrontUrl?: string;
    documentBackUrl?: string;
    selfieUrl?: string;
    livenessImageUrl?: string;
  }) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    return this.prisma.kycProfile.update({
      where: { userId },
      data,
    });
  }

  async checkExpiry(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const expiryDays = 365;
    const verifiedDate = profile.verifiedAt;
    if (!verifiedDate || profile.status !== 'APPROVED') {
      return { expired: false, status: profile.status, verifiedAt: null, expiresAt: null, daysRemaining: null };
    }

    const expiresAt = new Date(verifiedDate.getTime() + expiryDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    return {
      expired: daysRemaining <= 0,
      status: profile.status,
      verifiedAt: verifiedDate,
      expiresAt,
      daysRemaining: Math.max(0, daysRemaining),
    };
  }

  async getVerificationProgress(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const steps = [
      { step: 'personal_info', completed: !!(profile.firstName && profile.lastName), description: 'First and last name' },
      { step: 'document_type', completed: !!profile.documentType, description: 'Document type selected' },
      { step: 'document_number', completed: !!profile.documentNumber, description: 'Document number provided' },
      { step: 'document_front', completed: !!(profile as any).documentFrontUrl, description: 'Front of document uploaded' },
      { step: 'document_back', completed: !!(profile as any).documentBackUrl, description: 'Back of document uploaded' },
      { step: 'selfie', completed: !!(profile as any).selfieUrl, description: 'Selfie uploaded' },
      { step: 'liveness', completed: !!(profile as any).livenessImageUrl, description: 'Liveness check completed' },
      { step: 'review', completed: profile.status === 'APPROVED' || profile.status === 'REJECTED', description: 'Review completed' },
    ];

    const completedCount = steps.filter(s => s.completed).length;
    const progressPercent = Math.round((completedCount / steps.length) * 100);

    return {
      status: profile.status,
      progressPercent,
      completedSteps: completedCount,
      totalSteps: steps.length,
      steps,
    };
  }

  async getComplianceSummary(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) {
      return {
        kycStarted: false,
        status: null,
        documentComplete: false,
        identityVerified: false,
        riskScore: null,
        complianceReady: false,
        checksCompleted: { pep: false, sanctions: false },
        completionPercent: 0,
      };
    }

    const documentComplete = !!(profile.documentType && profile.documentNumber && (profile as any).documentFrontUrl);
    const identityVerified = profile.status === 'APPROVED' && !!profile.verifiedAt;
    const checksCompleted = {
      pep: profile.pepCheck ?? false,
      sanctions: profile.sanctionsCheck ?? false,
    };
    const complianceReady = identityVerified && checksCompleted.pep && checksCompleted.sanctions;

    const items = [
      !!profile.firstName,
      !!profile.documentType,
      !!profile.documentNumber,
      !!(profile as any).documentFrontUrl,
      !!(profile as any).selfieUrl,
      identityVerified,
      checksCompleted.pep,
      checksCompleted.sanctions,
    ];
    const completionPercent = Math.round((items.filter(Boolean).length / items.length) * 100);

    return {
      kycStarted: true,
      status: profile.status,
      documentComplete,
      identityVerified,
      riskScore: profile.riskScore,
      complianceReady,
      checksCompleted,
      completionPercent,
    };
  }

  async getRenewalReadiness(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) {
      return {
        kycExists: false,
        status: null,
        needsRenewal: false,
        renewalUrgency: 'none' as const,
        missingFields: ['all'],
        completionPercent: 0,
        daysUntilExpiry: null as number | null,
        recommendations: ['Start KYC verification'],
      };
    }

    const missingFields: string[] = [];
    if (!profile.firstName) missingFields.push('firstName');
    if (!profile.lastName) missingFields.push('lastName');
    if (!profile.documentType) missingFields.push('documentType');
    if (!profile.documentNumber) missingFields.push('documentNumber');
    if (!(profile as any).documentFrontUrl) missingFields.push('documentFrontUrl');
    if (!(profile as any).documentBackUrl) missingFields.push('documentBackUrl');
    if (!(profile as any).selfieUrl) missingFields.push('selfieUrl');
    if (!(profile as any).livenessImageUrl) missingFields.push('livenessImageUrl');

    const totalFields = 8;
    const completionPercent = Math.round(((totalFields - missingFields.length) / totalFields) * 100);

    let daysUntilExpiry: number | null = null;
    let needsRenewal = false;
    let renewalUrgency: 'none' | 'upcoming' | 'critical' | 'expired' = 'none';

    if (profile.status === 'APPROVED' && profile.verifiedAt) {
      const expiresAt = new Date(profile.verifiedAt.getTime() + 365 * 24 * 60 * 60 * 1000);
      daysUntilExpiry = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      if (daysUntilExpiry <= 0) { needsRenewal = true; renewalUrgency = 'expired'; }
      else if (daysUntilExpiry <= 30) { needsRenewal = true; renewalUrgency = 'critical'; }
      else if (daysUntilExpiry <= 90) { needsRenewal = true; renewalUrgency = 'upcoming'; }
    } else if (profile.status === 'REJECTED') {
      needsRenewal = true;
      renewalUrgency = 'critical';
    }

    const recommendations: string[] = [];
    if (profile.status === 'REJECTED') recommendations.push('Resubmit KYC with corrected information');
    if (renewalUrgency === 'expired') recommendations.push('KYC has expired, renewal required immediately');
    else if (renewalUrgency === 'critical') recommendations.push('KYC expires within 30 days, start renewal');
    else if (renewalUrgency === 'upcoming') recommendations.push('KYC expires within 90 days, plan renewal');
    if (missingFields.length > 0 && profile.status !== 'APPROVED') {
      recommendations.push(`Complete missing fields: ${missingFields.join(', ')}`);
    }
    if (!profile.pepCheck) recommendations.push('PEP check pending');
    if (!profile.sanctionsCheck) recommendations.push('Sanctions check pending');

    return {
      kycExists: true,
      status: profile.status,
      needsRenewal,
      renewalUrgency,
      missingFields,
      completionPercent,
      daysUntilExpiry,
      recommendations,
    };
  }

  async getOnboardingFunnel() {
    const profiles = await this.prisma.kycProfile.findMany({});

    const byStatus: Record<string, number> = {};
    const byDocumentType: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let approvedCount = 0;
    let rejectedCount = 0;
    let totalVerificationMs = 0;
    let verifiedWithTimeCount = 0;

    for (const p of profiles) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      if (p.documentType) byDocumentType[p.documentType] = (byDocumentType[p.documentType] ?? 0) + 1;
      if (p.documentCountry) byCountry[p.documentCountry] = (byCountry[p.documentCountry] ?? 0) + 1;

      if (p.status === 'APPROVED') {
        approvedCount++;
        if (p.verifiedAt) {
          totalVerificationMs += new Date(p.verifiedAt).getTime() - new Date(p.createdAt).getTime();
          verifiedWithTimeCount++;
        }
      } else if (p.status === 'REJECTED') {
        rejectedCount++;
      }
    }

    const totalProfiles = profiles.length;
    const approvalRate = totalProfiles > 0 ? Math.round(approvedCount / totalProfiles * 10000) / 100 : 0;
    const rejectionRate = totalProfiles > 0 ? Math.round(rejectedCount / totalProfiles * 10000) / 100 : 0;
    const avgVerificationDays = verifiedWithTimeCount > 0
      ? Math.round(totalVerificationMs / verifiedWithTimeCount / (1000 * 60 * 60 * 24) * 100) / 100
      : 0;

    return {
      totalProfiles,
      approvedCount,
      rejectedCount,
      pendingCount: totalProfiles - approvedCount - rejectedCount,
      approvalRate,
      rejectionRate,
      avgVerificationDays,
      byStatus,
      byDocumentType,
      byCountry,
    };
  }

  async setRiskScore(userId: string, riskScore: number) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    return this.prisma.kycProfile.update({
      where: { userId },
      data: { riskScore },
    });
  }
}
