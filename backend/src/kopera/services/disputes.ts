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

  async getStats(userId?: string) {
    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    const disputes = await this.prisma.dispute.findMany({ where });

    const byStatus: Record<string, number> = {};
    let totalAmount = BigInt(0);
    let resolvedCount = 0;
    let totalResolutionMs = 0;

    for (const d of disputes) {
      byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
      totalAmount += d.amount;
      if (d.resolvedAt) {
        resolvedCount++;
        totalResolutionMs += d.resolvedAt.getTime() - d.createdAt.getTime();
      }
    }

    return {
      totalDisputes: disputes.length,
      totalAmount,
      byStatus,
      avgResolutionDays: resolvedCount > 0
        ? Math.round(totalResolutionMs / resolvedCount / (1000 * 60 * 60 * 24) * 10) / 10
        : null,
    };
  }

  async getExpiringEvidence(userId: string, withinDays: number = 7) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });
    const now = new Date();
    const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

    return disputes
      .filter((d: any) =>
        (d.status === 'OPENED' || d.status === 'EVIDENCE_NEEDED') &&
        d.evidenceDeadline &&
        d.evidenceDeadline > now &&
        d.evidenceDeadline <= cutoff,
      )
      .map((d: any) => ({
        id: d.id,
        gatewayPaymentId: d.gatewayPaymentId,
        reason: d.reason,
        amount: d.amount,
        currency: d.currency,
        status: d.status,
        evidenceDeadline: d.evidenceDeadline,
        daysRemaining: Math.ceil((d.evidenceDeadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      }))
      .sort((a: any, b: any) => a.daysRemaining - b.daysRemaining);
  }

  async getResolutionReport(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });
    const resolved = disputes.filter((d: any) => d.resolvedAt);

    const byOutcome: Record<string, number> = {};
    const byReason: Record<string, { count: number; totalMs: number }> = {};
    let evidenceSubmittedCount = 0;

    for (const d of resolved) {
      byOutcome[d.status] = (byOutcome[d.status] ?? 0) + 1;
      const reason = d.reason ?? 'unknown';
      if (!byReason[reason]) byReason[reason] = { count: 0, totalMs: 0 };
      byReason[reason].count++;
      byReason[reason].totalMs += d.resolvedAt!.getTime() - d.createdAt.getTime();
      if ((d as any).evidenceSubmitted) evidenceSubmittedCount++;
    }

    const avgResolutionByReason: Record<string, number> = {};
    for (const [reason, data] of Object.entries(byReason)) {
      avgResolutionByReason[reason] = Math.round(data.totalMs / data.count / (1000 * 60 * 60 * 24) * 10) / 10;
    }

    return {
      totalDisputes: disputes.length,
      resolvedCount: resolved.length,
      pendingCount: disputes.length - resolved.length,
      byOutcome,
      avgResolutionByReason,
      evidenceSubmissionRate: disputes.length > 0
        ? Math.round(evidenceSubmittedCount / disputes.length * 100)
        : 0,
    };
  }

  async getRiskAssessment(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });

    let totalAmount = BigInt(0);
    let escalatedCount = 0;
    let highValueCount = 0;
    let recentCount = 0;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const byStatus: Record<string, number> = {};

    for (const d of disputes) {
      totalAmount += d.amount;
      byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
      if (d.status === 'EVIDENCE_NEEDED' || d.status === 'UNDER_REVIEW') escalatedCount++;
      if (d.amount > BigInt(100000)) highValueCount++;
      if (d.createdAt > thirtyDaysAgo) recentCount++;
    }

    const escalationRate = disputes.length > 0
      ? Math.round((escalatedCount / disputes.length) * 10000) / 100
      : 0;

    let riskScore = 0;
    if (disputes.length > 5) riskScore += 20;
    else if (disputes.length > 2) riskScore += 10;
    if (recentCount > 3) riskScore += 25;
    else if (recentCount > 1) riskScore += 10;
    if (escalationRate > 50) riskScore += 20;
    else if (escalationRate > 25) riskScore += 10;
    if (highValueCount > 2) riskScore += 20;
    else if (highValueCount > 0) riskScore += 10;
    const lostCount = byStatus['LOST'] ?? 0;
    if (lostCount > 2) riskScore += 15;
    else if (lostCount > 0) riskScore += 5;

    riskScore = Math.min(100, riskScore);
    const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : 'low';

    return {
      totalDisputes: disputes.length,
      totalAmount,
      recentDisputes: recentCount,
      escalatedCount,
      escalationRate,
      highValueCount,
      riskScore,
      riskLevel,
      byStatus,
    };
  }

  async getEscalationAnalysis(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });

    let escalatedCount = 0;
    let nonEscalatedCount = 0;
    let totalEscalationTimeMs = 0;
    let escalatedWithTimeCount = 0;
    let escalatedResolvedCount = 0;
    let nonEscalatedResolvedCount = 0;
    let escalatedResolvedTimeMs = 0;
    let nonEscalatedResolvedTimeMs = 0;
    const reasonEscalationCount: Record<string, { escalated: number; total: number }> = {};

    for (const d of disputes) {
      const reason = d.reason ?? 'unknown';
      if (!reasonEscalationCount[reason]) reasonEscalationCount[reason] = { escalated: 0, total: 0 };
      reasonEscalationCount[reason].total++;

      const wasEscalated = d.status === 'EVIDENCE_NEEDED' || d.status === 'UNDER_REVIEW' ||
        ((d as any).evidenceSubmitted != null);

      if (wasEscalated) {
        escalatedCount++;
        reasonEscalationCount[reason].escalated++;
        if (d.resolvedAt) {
          escalatedResolvedCount++;
          escalatedResolvedTimeMs += d.resolvedAt.getTime() - d.createdAt.getTime();
        }
      } else {
        nonEscalatedCount++;
        if (d.resolvedAt) {
          nonEscalatedResolvedCount++;
          nonEscalatedResolvedTimeMs += d.resolvedAt.getTime() - d.createdAt.getTime();
        }
      }
    }

    const escalationRate = disputes.length > 0
      ? Math.round((escalatedCount / disputes.length) * 10000) / 100
      : 0;

    const avgEscalatedResolutionDays = escalatedResolvedCount > 0
      ? Math.round(escalatedResolvedTimeMs / escalatedResolvedCount / (1000 * 60 * 60 * 24) * 10) / 10
      : null;
    const avgNonEscalatedResolutionDays = nonEscalatedResolvedCount > 0
      ? Math.round(nonEscalatedResolvedTimeMs / nonEscalatedResolvedCount / (1000 * 60 * 60 * 24) * 10) / 10
      : null;

    const reasonBreakdown = Object.entries(reasonEscalationCount)
      .map(([reason, data]) => ({
        reason,
        total: data.total,
        escalated: data.escalated,
        escalationRate: data.total > 0 ? Math.round((data.escalated / data.total) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.escalationRate - a.escalationRate);

    return {
      totalDisputes: disputes.length,
      escalatedCount,
      nonEscalatedCount,
      escalationRate,
      avgEscalatedResolutionDays,
      avgNonEscalatedResolutionDays,
      reasonBreakdown,
    };
  }

  async getFinancialImpact(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });

    let totalDisputed = BigInt(0);
    let totalRecovered = BigInt(0);
    let totalLost = BigInt(0);
    let pendingExposure = BigInt(0);
    const byCurrency: Record<string, { disputed: bigint; recovered: bigint; lost: bigint; pending: bigint; count: number }> = {};

    for (const d of disputes) {
      totalDisputed += d.amount;
      if (!byCurrency[d.currency]) byCurrency[d.currency] = { disputed: BigInt(0), recovered: BigInt(0), lost: BigInt(0), pending: BigInt(0), count: 0 };
      byCurrency[d.currency].disputed += d.amount;
      byCurrency[d.currency].count++;

      if (d.status === 'WON') {
        totalRecovered += d.amount;
        byCurrency[d.currency].recovered += d.amount;
      } else if (d.status === 'LOST') {
        totalLost += d.amount;
        byCurrency[d.currency].lost += d.amount;
      } else if (d.status !== 'ACCEPTED') {
        pendingExposure += d.amount;
        byCurrency[d.currency].pending += d.amount;
      }
    }

    const avgDisputeSize = disputes.length > 0 ? totalDisputed / BigInt(disputes.length) : BigInt(0);
    const recoveryRate = disputes.length > 0
      ? Math.round(disputes.filter(d => d.status === 'WON').length / disputes.length * 10000) / 100
      : 0;

    const serializedByCurrency: Record<string, { disputed: string; recovered: string; lost: string; pending: string; count: number }> = {};
    for (const [cur, data] of Object.entries(byCurrency)) {
      serializedByCurrency[cur] = {
        disputed: data.disputed.toString(),
        recovered: data.recovered.toString(),
        lost: data.lost.toString(),
        pending: data.pending.toString(),
        count: data.count,
      };
    }

    return {
      totalDisputes: disputes.length,
      totalDisputed: totalDisputed.toString(),
      totalRecovered: totalRecovered.toString(),
      totalLost: totalLost.toString(),
      pendingExposure: pendingExposure.toString(),
      avgDisputeSize: avgDisputeSize.toString(),
      recoveryRate,
      byCurrency: serializedByCurrency,
    };
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
