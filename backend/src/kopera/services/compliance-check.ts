import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class ComplianceCheckService {
  constructor(private prisma: PrismaClient) {}

  async createCheck(userId: string, data: {
    checkType: string;
    entityId: string;
    entityType: string;
  }) {
    return this.prisma.complianceCheck.create({
      data: {
        userId,
        checkType: data.checkType.toUpperCase(),
        entityId: data.entityId,
        entityType: data.entityType.toUpperCase(),
        riskLevel: 'PENDING',
        status: 'IN_PROGRESS',
        reference: `CCK-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getChecks(userId: string) {
    return this.prisma.complianceCheck.findMany({ where: { userId } });
  }

  async getCheck(userId: string, id: string) {
    const c = await this.prisma.complianceCheck.findUnique({ where: { id } });
    if (!c) throw new Error('check_not_found');
    if ((c as any).userId !== userId) throw new Error('check_not_found');
    return c;
  }

  async completeCheck(userId: string, id: string, riskLevel: string, findings?: string) {
    const c = await this.getCheck(userId, id);
    if ((c as any).status !== 'IN_PROGRESS') throw new Error('check_not_in_progress');

    return this.prisma.complianceCheck.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        riskLevel: riskLevel.toUpperCase(),
        findings: findings || null,
        completedAt: new Date(),
      },
    });
  }

  async flagCheck(userId: string, id: string, reason: string) {
    const c = await this.getCheck(userId, id);
    if ((c as any).status !== 'COMPLETED') throw new Error('check_not_completed');

    return this.prisma.complianceCheck.update({
      where: { id },
      data: { status: 'FLAGGED', flagReason: reason, flaggedAt: new Date() },
    });
  }

  async getCheckAnalytics(userId: string) {
    const checks = await this.prisma.complianceCheck.findMany({ where: { userId } });

    if (checks.length === 0) {
      return {
        totalChecks: 0,
        breakdown: { IN_PROGRESS: 0, COMPLETED: 0, FLAGGED: 0 },
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { IN_PROGRESS: 0, COMPLETED: 0, FLAGGED: 0 };
    for (const c of checks as any[]) {
      if (c.status in breakdown) breakdown[c.status]++;
    }

    return {
      totalChecks: checks.length,
      breakdown,
      analyticsLevel: checks.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
