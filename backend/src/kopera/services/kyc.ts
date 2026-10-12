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

  async setRiskScore(userId: string, riskScore: number) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    return this.prisma.kycProfile.update({
      where: { userId },
      data: { riskScore },
    });
  }
}
