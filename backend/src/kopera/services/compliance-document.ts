import type { PrismaClient } from '@prisma/client';

export class ComplianceDocumentService {
  constructor(private prisma: PrismaClient) {}

  async createDocument(userId: string, data: {
    documentType: string;
    title: string;
    description: string;
    jurisdiction: string;
    effectiveDate: string;
  }) {
    return this.prisma.complianceDocument.create({
      data: {
        userId,
        documentType: data.documentType.toUpperCase(),
        title: data.title,
        description: data.description,
        jurisdiction: data.jurisdiction.toUpperCase(),
        effectiveDate: new Date(data.effectiveDate),
        status: 'DRAFT',
        version: 1,
        reviewCount: 0,
        lastReviewedAt: null,
        approvedBy: null,
      },
    });
  }

  async getDocuments(userId: string) {
    return this.prisma.complianceDocument.findMany({ where: { userId } });
  }

  async getDocument(userId: string, id: string) {
    const d = await this.prisma.complianceDocument.findFirst({ where: { id, userId } });
    if (!d) throw new Error('document_not_found');
    return d;
  }

  async submitForReview(userId: string, id: string) {
    const d = await this.prisma.complianceDocument.findFirst({ where: { id, userId } });
    if (!d) throw new Error('document_not_found');
    if (d.status !== 'DRAFT') throw new Error('document_not_draft');
    return this.prisma.complianceDocument.update({
      where: { id },
      data: { status: 'IN_REVIEW', reviewCount: d.reviewCount + 1, lastReviewedAt: new Date() },
    });
  }

  async approveDocument(userId: string, id: string, approvedBy: string) {
    const d = await this.prisma.complianceDocument.findFirst({ where: { id, userId } });
    if (!d) throw new Error('document_not_found');
    if (d.status !== 'IN_REVIEW') throw new Error('document_not_in_review');
    return this.prisma.complianceDocument.update({
      where: { id },
      data: { status: 'APPROVED', approvedBy, approvedAt: new Date() },
    });
  }

  async archiveDocument(userId: string, id: string) {
    const d = await this.prisma.complianceDocument.findFirst({ where: { id, userId } });
    if (!d) throw new Error('document_not_found');
    if (d.status !== 'APPROVED') throw new Error('document_not_approved');
    return this.prisma.complianceDocument.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
  }

  async getDocumentAnalytics(userId: string) {
    const all = await this.prisma.complianceDocument.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalDocuments: 0, analyticsLevel: 'no_data' as const };
    }
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const d of all) {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
      byType[d.documentType] = (byType[d.documentType] || 0) + 1;
    }
    return {
      totalDocuments: all.length,
      byStatus,
      byType,
      analyticsLevel: 'full' as const,
    };
  }
}
