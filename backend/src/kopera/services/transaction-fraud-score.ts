import type { PrismaClient } from '@prisma/client';

export class TransactionFraudScoreService {
  constructor(private prisma: PrismaClient) {}

  async createScore(userId: string, data: {
    transactionId: string;
    score: number;
    riskLevel: string;
    factors: string;
    model: string;
  }) {
    return this.prisma.transactionFraudScore.create({
      data: {
        userId,
        transactionId: data.transactionId,
        score: data.score,
        riskLevel: data.riskLevel.toUpperCase(),
        factors: data.factors,
        model: data.model,
        status: 'PENDING_REVIEW',
        reviewedAt: null,
        reviewedBy: null,
        decision: null,
      },
    });
  }

  async getScores(userId: string) {
    return this.prisma.transactionFraudScore.findMany({ where: { userId } });
  }

  async getScore(userId: string, id: string) {
    const s = await this.prisma.transactionFraudScore.findFirst({ where: { id, userId } });
    if (!s) throw new Error('score_not_found');
    return s;
  }

  async reviewScore(userId: string, id: string, data: { decision: string; reviewedBy: string }) {
    const s = await this.prisma.transactionFraudScore.findFirst({ where: { id, userId } });
    if (!s) throw new Error('score_not_found');
    if (s.status !== 'PENDING_REVIEW') throw new Error('score_already_reviewed');
    return this.prisma.transactionFraudScore.update({
      where: { id },
      data: {
        status: 'REVIEWED',
        decision: data.decision.toUpperCase(),
        reviewedBy: data.reviewedBy,
        reviewedAt: new Date(),
      },
    });
  }

  async escalateScore(userId: string, id: string) {
    const s = await this.prisma.transactionFraudScore.findFirst({ where: { id, userId } });
    if (!s) throw new Error('score_not_found');
    if (s.status !== 'PENDING_REVIEW') throw new Error('score_not_pending');
    return this.prisma.transactionFraudScore.update({
      where: { id },
      data: { status: 'ESCALATED' },
    });
  }

  async getScoreAnalytics(userId: string) {
    const all = await this.prisma.transactionFraudScore.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalScores: 0, analyticsLevel: 'no_data' as const };
    }
    const byRiskLevel: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalScore = 0;
    for (const s of all) {
      byRiskLevel[s.riskLevel] = (byRiskLevel[s.riskLevel] || 0) + 1;
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      totalScore += s.score;
    }
    return {
      totalScores: all.length,
      averageScore: Math.round(totalScore / all.length),
      byRiskLevel,
      byStatus,
      analyticsLevel: 'full' as const,
    };
  }
}
