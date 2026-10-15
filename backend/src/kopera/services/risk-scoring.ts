import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class RiskScoringService {
  constructor(private prisma: PrismaClient) {}

  async createAssessment(userId: string, data: {
    entityType: string;
    entityId: string;
    riskScore: number;
    riskLevel: string;
    factors: string[];
    notes?: string;
  }) {
    if (data.riskScore < 0 || data.riskScore > 100) throw new Error('invalid_risk_score');

    return this.prisma.riskAssessment.create({
      data: {
        userId,
        entityType: data.entityType,
        entityId: data.entityId,
        riskScore: data.riskScore,
        riskLevel: data.riskLevel.toUpperCase(),
        factors: JSON.stringify(data.factors),
        notes: data.notes || null,
        status: 'ACTIVE',
        reference: `RSK-${Date.now()}-${randomUUID().slice(0, 8)}`,
        assessedAt: new Date(),
      },
    });
  }

  async getAssessments(userId: string) {
    return this.prisma.riskAssessment.findMany({ where: { userId } });
  }

  async getAssessment(userId: string, id: string) {
    const assessment = await this.prisma.riskAssessment.findUnique({ where: { id } });
    if (!assessment) throw new Error('assessment_not_found');
    if ((assessment as any).userId !== userId) throw new Error('assessment_not_found');
    return assessment;
  }

  async updateScore(userId: string, id: string, data: {
    riskScore: number;
    riskLevel: string;
    factors?: string[];
    notes?: string;
  }) {
    await this.getAssessment(userId, id);
    if (data.riskScore < 0 || data.riskScore > 100) throw new Error('invalid_risk_score');

    const updateData: Record<string, unknown> = {
      riskScore: data.riskScore,
      riskLevel: data.riskLevel.toUpperCase(),
      reassessedAt: new Date(),
    };
    if (data.factors) updateData.factors = JSON.stringify(data.factors);
    if (data.notes !== undefined) updateData.notes = data.notes;

    return this.prisma.riskAssessment.update({ where: { id }, data: updateData });
  }

  async archiveAssessment(userId: string, id: string) {
    const assessment = await this.getAssessment(userId, id);
    if ((assessment as any).status === 'ARCHIVED') throw new Error('assessment_already_archived');

    return this.prisma.riskAssessment.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  async getByEntity(userId: string, entityType: string, entityId: string) {
    const assessments = await this.prisma.riskAssessment.findMany({ where: { userId } });
    return (assessments as any[]).filter(
      (a) => a.entityType === entityType && a.entityId === entityId,
    );
  }

  async getRiskAnalytics(userId: string) {
    const assessments = await this.prisma.riskAssessment.findMany({ where: { userId } });

    if (assessments.length === 0) {
      return {
        totalAssessments: 0,
        breakdown: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 },
        averageScore: 0,
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    let totalScore = 0;
    for (const a of assessments as any[]) {
      const level = a.riskLevel as string;
      if (level in breakdown) breakdown[level]++;
      totalScore += a.riskScore || 0;
    }

    return {
      totalAssessments: assessments.length,
      breakdown,
      averageScore: Math.round(totalScore / assessments.length),
      analyticsLevel: assessments.length >= 5 ? 'sufficient' : 'limited',
    };
  }
}
