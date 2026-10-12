import type { PrismaClient } from '@prisma/client';

export class DisputeService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    gatewayPaymentId: string;
    reason: string;
    amount: bigint;
    currency: string;
  }) {
    const gp = await this.prisma.gatewayPayment.findUnique({
      where: { id: params.gatewayPaymentId },
    });
    if (!gp) throw new Error('payment_not_found');

    const existing = await this.prisma.dispute.findUnique({
      where: { gatewayPaymentId: params.gatewayPaymentId },
    });
    if (existing) throw new Error('dispute_already_exists');

    return this.prisma.dispute.create({
      data: {
        userId: params.userId,
        gatewayPaymentId: params.gatewayPaymentId,
        reason: params.reason,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        status: 'OPENED',
        evidenceDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }

  async getById(disputeId: string) {
    return this.prisma.dispute.findUnique({ where: { id: disputeId } });
  }

  async listByUser(userId: string) {
    return this.prisma.dispute.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async submitEvidence(disputeId: string, userId: string, evidence: Record<string, unknown>) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new Error('dispute_not_found');
    if (dispute.userId !== userId) throw new Error('forbidden');
    if (dispute.status !== 'OPENED' && dispute.status !== 'EVIDENCE_NEEDED') {
      throw new Error('dispute_not_open');
    }

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        evidenceSubmitted: evidence as any,
        status: 'UNDER_REVIEW',
      },
    });
  }

  async escalate(disputeId: string, userId: string) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new Error('dispute_not_found');
    if (dispute.userId !== userId) throw new Error('forbidden');
    if (dispute.status !== 'OPENED') throw new Error('dispute_not_open');

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: { status: 'EVIDENCE_NEEDED' },
    });
  }

  async listAll(opts?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = {};
    if (opts?.status) where.status = opts.status;
    return this.prisma.dispute.findMany({
      where,
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async resolve(disputeId: string, outcome: string, notes?: string) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new Error('dispute_not_found');
    if (dispute.status === 'WON' || dispute.status === 'LOST' || dispute.status === 'ACCEPTED') {
      throw new Error('dispute_already_resolved');
    }

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: outcome as any,
        outcome: notes ?? outcome,
        resolvedAt: new Date(),
      },
    });
  }
}
