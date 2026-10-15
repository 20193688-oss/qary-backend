import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentDisputeEvidenceService {
  constructor(private prisma: PrismaClient) {}

  async createEvidence(userId: string, data: {
    disputeId: string;
    evidenceType: string;
    description: string;
    fileUrl?: string;
  }) {
    return this.prisma.paymentDisputeEvidence.create({
      data: {
        userId,
        disputeId: data.disputeId,
        evidenceType: data.evidenceType.toUpperCase(),
        description: data.description,
        fileUrl: data.fileUrl || null,
        status: 'SUBMITTED',
        reference: `PDE-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getEvidenceList(userId: string) {
    return this.prisma.paymentDisputeEvidence.findMany({ where: { userId } });
  }

  async getEvidence(userId: string, id: string) {
    const e = await this.prisma.paymentDisputeEvidence.findUnique({ where: { id } });
    if (!e) throw new Error('evidence_not_found');
    if ((e as any).userId !== userId) throw new Error('evidence_not_found');
    return e;
  }

  async reviewEvidence(userId: string, id: string) {
    const e = await this.getEvidence(userId, id);
    if ((e as any).status !== 'SUBMITTED') throw new Error('evidence_not_submitted');

    return this.prisma.paymentDisputeEvidence.update({
      where: { id },
      data: { status: 'UNDER_REVIEW', reviewedAt: new Date() },
    });
  }

  async acceptEvidence(userId: string, id: string) {
    const e = await this.getEvidence(userId, id);
    if ((e as any).status !== 'UNDER_REVIEW') throw new Error('evidence_not_under_review');

    return this.prisma.paymentDisputeEvidence.update({
      where: { id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
  }

  async rejectEvidence(userId: string, id: string, reason: string) {
    const e = await this.getEvidence(userId, id);
    if ((e as any).status !== 'UNDER_REVIEW') throw new Error('evidence_not_under_review');

    return this.prisma.paymentDisputeEvidence.update({
      where: { id },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectionReason: reason },
    });
  }

  async getEvidenceAnalytics(userId: string) {
    const items = await this.prisma.paymentDisputeEvidence.findMany({ where: { userId } });

    if (items.length === 0) {
      return {
        totalEvidence: 0,
        breakdown: { SUBMITTED: 0, UNDER_REVIEW: 0, ACCEPTED: 0, REJECTED: 0 },
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { SUBMITTED: 0, UNDER_REVIEW: 0, ACCEPTED: 0, REJECTED: 0 };
    for (const e of items as any[]) {
      if (e.status in breakdown) breakdown[e.status]++;
    }

    return {
      totalEvidence: items.length,
      breakdown,
      analyticsLevel: items.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
