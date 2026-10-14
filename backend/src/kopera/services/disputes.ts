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

  async getOutcomeAnalysis(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });

    if (disputes.length === 0) {
      return {
        totalDisputes: 0,
        resolved: 0,
        pending: 0,
        winRate: 0,
        byReason: [],
        byCurrency: [],
      };
    }

    const resolved = disputes.filter((d) =>
      d.status === 'WON' || d.status === 'LOST' || d.status === 'ACCEPTED',
    );
    const pending = disputes.length - resolved.length;
    const won = resolved.filter((d) => d.status === 'WON').length;
    const winRate = resolved.length > 0 ? Math.round((won / resolved.length) * 10000) / 100 : 0;

    const reasonMap = new Map<string, { total: number; won: number; lost: number; accepted: number; totalAmount: bigint }>();
    for (const d of disputes) {
      const reason = d.reason ?? 'unknown';
      const entry = reasonMap.get(reason) ?? { total: 0, won: 0, lost: 0, accepted: 0, totalAmount: BigInt(0) };
      entry.total++;
      if (d.status === 'WON') entry.won++;
      if (d.status === 'LOST') entry.lost++;
      if (d.status === 'ACCEPTED') entry.accepted++;
      entry.totalAmount += d.amount ?? BigInt(0);
      reasonMap.set(reason, entry);
    }

    const byReason = Array.from(reasonMap.entries()).map(([reason, data]) => ({
      reason,
      total: data.total,
      won: data.won,
      lost: data.lost,
      accepted: data.accepted,
      winRate: (data.won + data.lost) > 0
        ? Math.round((data.won / (data.won + data.lost)) * 10000) / 100
        : 0,
      totalAmount: data.totalAmount.toString(),
    })).sort((a, b) => b.total - a.total);

    const currencyMap = new Map<string, { total: number; won: number; totalAmount: bigint }>();
    for (const d of disputes) {
      const cur = d.currency ?? 'USD';
      const entry = currencyMap.get(cur) ?? { total: 0, won: 0, totalAmount: BigInt(0) };
      entry.total++;
      if (d.status === 'WON') entry.won++;
      entry.totalAmount += d.amount ?? BigInt(0);
      currencyMap.set(cur, entry);
    }

    const byCurrency = Array.from(currencyMap.entries()).map(([currency, data]) => ({
      currency,
      total: data.total,
      won: data.won,
      winRate: data.total > 0 ? Math.round((data.won / data.total) * 10000) / 100 : 0,
      totalAmount: data.totalAmount.toString(),
    })).sort((a, b) => b.total - a.total);

    return {
      totalDisputes: disputes.length,
      resolved: resolved.length,
      pending,
      winRate,
      byReason,
      byCurrency,
    };
  }

  async getResponseTimeAnalysis(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });

    if (disputes.length === 0) {
      return {
        totalDisputes: 0,
        resolvedCount: 0,
        avgResponseDays: 0,
        medianResponseDays: 0,
        fastestDays: 0,
        slowestDays: 0,
        bySpeed: [],
        slaCompliance: 0,
      };
    }

    const resolved = disputes.filter(
      (d) => d.resolvedAt && (d.status === 'WON' || d.status === 'LOST' || d.status === 'ACCEPTED'),
    );

    if (resolved.length === 0) {
      const pendingDays = disputes.map((d) => {
        const ms = Date.now() - new Date(d.createdAt).getTime();
        return Math.round(ms / 86400000);
      });
      return {
        totalDisputes: disputes.length,
        resolvedCount: 0,
        avgResponseDays: 0,
        medianResponseDays: 0,
        fastestDays: 0,
        slowestDays: 0,
        bySpeed: [
          { bucket: 'pending', count: disputes.length, avgDaysOpen: Math.round(pendingDays.reduce((s, d) => s + d, 0) / pendingDays.length) },
        ],
        slaCompliance: 0,
      };
    }

    const responseDays = resolved.map((d) => {
      const ms = new Date(d.resolvedAt!).getTime() - new Date(d.createdAt).getTime();
      return Math.max(0, Math.round(ms / 86400000));
    }).sort((a, b) => a - b);

    const avg = Math.round(responseDays.reduce((s, d) => s + d, 0) / responseDays.length);
    const median = responseDays[Math.floor(responseDays.length / 2)];
    const fastest = responseDays[0];
    const slowest = responseDays[responseDays.length - 1];

    const buckets = [
      { bucket: 'fast', label: '0-7 days', min: 0, max: 7 },
      { bucket: 'normal', label: '8-30 days', min: 8, max: 30 },
      { bucket: 'slow', label: '31-60 days', min: 31, max: 60 },
      { bucket: 'very_slow', label: '60+ days', min: 61, max: Infinity },
    ];

    const bySpeed = buckets.map((b) => {
      const inBucket = responseDays.filter((d) => d >= b.min && d <= b.max);
      return {
        bucket: b.bucket,
        label: b.label,
        count: inBucket.length,
        percent: Math.round((inBucket.length / responseDays.length) * 10000) / 100,
      };
    }).filter((b) => b.count > 0);

    const within30 = responseDays.filter((d) => d <= 30).length;
    const slaCompliance = Math.round((within30 / responseDays.length) * 10000) / 100;

    return {
      totalDisputes: disputes.length,
      resolvedCount: resolved.length,
      avgResponseDays: avg,
      medianResponseDays: median,
      fastestDays: fastest,
      slowestDays: slowest,
      bySpeed,
      slaCompliance,
    };
  }

  async getDisputeOutcomePredictor(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });
    if (disputes.length === 0) {
      return {
        totalDisputes: 0,
        resolvedCount: 0,
        winRate: 0,
        avgResolutionDays: 0,
        byCategory: [],
        predictedOutcome: null,
      };
    }

    const resolved = disputes.filter((d: any) => d.status === 'resolved' || d.status === 'closed' || d.status === 'won' || d.status === 'lost');
    const won = resolved.filter((d: any) => d.status === 'won' || d.resolution === 'accepted' || d.resolution === 'refunded');
    const winRate = resolved.length > 0 ? Math.round((won.length / resolved.length) * 10000) / 100 : 0;

    const resolutionDays: number[] = [];
    for (const d of resolved) {
      const resolvedAt = (d as any).resolvedAt || (d as any).updatedAt;
      if (resolvedAt) {
        const days = (new Date(resolvedAt).getTime() - new Date(d.createdAt).getTime()) / 86400000;
        resolutionDays.push(days);
      }
    }
    const avgResolutionDays = resolutionDays.length > 0
      ? Math.round((resolutionDays.reduce((s, d) => s + d, 0) / resolutionDays.length) * 10) / 10
      : 0;

    const categoryMap = new Map<string, { total: number; won: number; totalAmount: bigint }>();
    for (const d of disputes) {
      const cat = (d as any).category || (d as any).reason || 'uncategorized';
      if (!categoryMap.has(cat)) categoryMap.set(cat, { total: 0, won: 0, totalAmount: BigInt(0) });
      const entry = categoryMap.get(cat)!;
      entry.total++;
      if (d.status === 'won' || (d as any).resolution === 'accepted') entry.won++;
      entry.totalAmount += (d as any).amount ?? BigInt(0);
    }

    const byCategory = Array.from(categoryMap.entries())
      .map(([category, data]) => ({
        category,
        count: data.total,
        winRate: data.total > 0 ? Math.round((data.won / data.total) * 10000) / 100 : 0,
        totalAmount: data.totalAmount.toString(),
      }))
      .sort((a, b) => b.count - a.count);

    const pending = disputes.filter((d: any) => d.status === 'open' || d.status === 'pending' || d.status === 'under_review');
    let predictedOutcome: string | null = null;
    if (pending.length > 0) {
      predictedOutcome = winRate >= 60 ? 'likely_favorable' : winRate >= 40 ? 'uncertain' : 'likely_unfavorable';
    }

    return {
      totalDisputes: disputes.length,
      resolvedCount: resolved.length,
      winRate,
      avgResolutionDays,
      byCategory,
      predictedOutcome,
    };
  }

  async getDisputeAgingReport(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });
    if (disputes.length === 0) {
      return {
        totalDisputes: 0,
        avgAgeDays: 0,
        oldestAgeDays: 0,
        ageBuckets: [],
        stalledCount: 0,
      };
    }

    const now = Date.now();
    const ages = disputes.map(d => {
      const created = new Date(d.createdAt).getTime();
      const resolved = (d as any).resolvedAt ? new Date((d as any).resolvedAt).getTime() : now;
      return { id: d.id, status: (d as any).status || 'open', ageDays: Math.round((resolved - created) / 86400000) };
    });

    const buckets: Record<string, number> = { '0-7': 0, '8-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const a of ages) {
      if (a.ageDays <= 7) buckets['0-7']++;
      else if (a.ageDays <= 30) buckets['8-30']++;
      else if (a.ageDays <= 60) buckets['31-60']++;
      else if (a.ageDays <= 90) buckets['61-90']++;
      else buckets['90+']++;
    }

    const avgAgeDays = Math.round(ages.reduce((s, a) => s + a.ageDays, 0) / ages.length);
    const oldestAgeDays = Math.max(...ages.map(a => a.ageDays));
    const stalledCount = ages.filter(a => a.ageDays > 30 && a.status !== 'resolved' && a.status !== 'won' && a.status !== 'lost').length;

    const ageBuckets = Object.entries(buckets).map(([range, count]) => ({ range, count }));

    return {
      totalDisputes: disputes.length,
      avgAgeDays,
      oldestAgeDays,
      ageBuckets,
      stalledCount,
    };
  }

  async getDisputeResolutionEfficiency(userId: string) {
    const disputes = await this.prisma.dispute.findMany({ where: { userId } });
    if (disputes.length === 0) {
      return {
        totalDisputes: 0,
        resolvedCount: 0,
        resolutionRate: 0,
        avgResolutionDays: 0,
        fastestResolutionDays: 0,
        slowestResolutionDays: 0,
        efficiencyScore: 100,
        efficiencyLevel: 'no_data',
        recommendations: [],
      };
    }

    const resolved = disputes.filter(d => {
      const s = ((d as any).status || '').toLowerCase();
      return s === 'resolved' || s === 'won' || s === 'lost';
    });

    const resolutionRate = Math.round((resolved.length / disputes.length) * 10000) / 100;

    const resolutionDays = resolved.map(d => {
      const created = new Date(d.createdAt).getTime();
      const resolvedAt = (d as any).resolvedAt ? new Date((d as any).resolvedAt).getTime() : Date.now();
      return Math.max(1, Math.round((resolvedAt - created) / 86400000));
    });

    const avgResolutionDays = resolutionDays.length > 0
      ? Math.round(resolutionDays.reduce((s, d) => s + d, 0) / resolutionDays.length)
      : 0;
    const fastestResolutionDays = resolutionDays.length > 0 ? Math.min(...resolutionDays) : 0;
    const slowestResolutionDays = resolutionDays.length > 0 ? Math.max(...resolutionDays) : 0;

    let efficiencyScore = 100;
    if (resolutionRate < 50) efficiencyScore -= 30;
    else if (resolutionRate < 80) efficiencyScore -= 15;
    if (avgResolutionDays > 30) efficiencyScore -= 25;
    else if (avgResolutionDays > 14) efficiencyScore -= 10;
    const pending = disputes.length - resolved.length;
    if (pending > 5) efficiencyScore -= 20;
    efficiencyScore = Math.max(0, efficiencyScore);

    const efficiencyLevel = efficiencyScore >= 80 ? 'excellent' : efficiencyScore >= 50 ? 'fair' : 'poor';

    const recommendations: string[] = [];
    if (resolutionRate < 80) recommendations.push('Increase dispute resolution rate by following up on open cases');
    if (avgResolutionDays > 14) recommendations.push('Reduce average resolution time by prioritizing older disputes');
    if (pending > 5) recommendations.push('Address backlog of pending disputes');

    return {
      totalDisputes: disputes.length,
      resolvedCount: resolved.length,
      resolutionRate,
      avgResolutionDays,
      fastestResolutionDays,
      slowestResolutionDays,
      efficiencyScore,
      efficiencyLevel,
      recommendations,
    };
  }
}
