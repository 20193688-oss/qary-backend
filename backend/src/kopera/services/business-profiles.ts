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

  async reject(userId: string, reason: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('profile_not_found');

    return this.prisma.businessProfile.update({
      where: { userId },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
  }
}
