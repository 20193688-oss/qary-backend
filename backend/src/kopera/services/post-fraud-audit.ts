import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PostFraudAuditService {
  constructor(private prisma: PrismaClient) {}

  async createAuditCase(userId: string, data: {
    fraudAlertId: string;
    transactionId?: string;
    reportedAmount: bigint;
    currency: string;
    description: string;
  }) {
    const alert = await this.prisma.fraudAlert.findUnique({ where: { id: data.fraudAlertId } });
    if (!alert) throw new Error('fraud_alert_not_found');
    if ((alert as any).userId !== userId) throw new Error('fraud_alert_not_found');

    return this.prisma.postFraudAudit.create({
      data: {
        userId,
        fraudAlertId: data.fraudAlertId,
        transactionId: data.transactionId || null,
        reportedAmount: data.reportedAmount,
        currency: data.currency.toUpperCase(),
        description: data.description,
        status: 'OPEN',
        phase: 'INVESTIGATION',
        reference: `PFA-${Date.now()}-${randomUUID().slice(0, 8)}`,
        openedAt: new Date(),
      },
    });
  }

  async getAuditCases(userId: string) {
    return this.prisma.postFraudAudit.findMany({ where: { userId } });
  }

  async getAuditCase(userId: string, id: string) {
    const audit = await this.prisma.postFraudAudit.findUnique({ where: { id } });
    if (!audit) throw new Error('audit_case_not_found');
    if ((audit as any).userId !== userId) throw new Error('audit_case_not_found');
    return audit;
  }

  async updatePhase(userId: string, id: string, phase: string) {
    const audit = await this.getAuditCase(userId, id);
    if ((audit as any).status !== 'OPEN') throw new Error('audit_case_closed');
    const validPhases = ['INVESTIGATION', 'EVIDENCE_COLLECTION', 'REVIEW', 'RECOVERY', 'CLOSED'];
    if (!validPhases.includes(phase)) throw new Error('invalid_phase');

    const updateData: any = { phase };
    if (phase === 'CLOSED') {
      updateData.status = 'CLOSED';
      updateData.closedAt = new Date();
    }

    return this.prisma.postFraudAudit.update({
      where: { id },
      data: updateData,
    });
  }

  async recordRecovery(userId: string, auditId: string, data: {
    recoveredAmount: bigint;
    method: string;
    notes?: string;
  }) {
    const audit = await this.getAuditCase(userId, auditId);
    if ((audit as any).status !== 'OPEN') throw new Error('audit_case_closed');

    const recovery = await this.prisma.fundRecovery.create({
      data: {
        auditId,
        userId,
        recoveredAmount: data.recoveredAmount,
        currency: (audit as any).currency,
        method: data.method,
        notes: data.notes || null,
        status: 'COMPLETED',
        reference: `RCV-${Date.now()}-${randomUUID().slice(0, 8)}`,
        recoveredAt: new Date(),
      },
    });

    const currentRecovered = (audit as any).totalRecovered as bigint || BigInt(0);
    await this.prisma.postFraudAudit.update({
      where: { id: auditId },
      data: { totalRecovered: currentRecovered + data.recoveredAmount },
    });

    return recovery;
  }

  async getRecoveryAnalytics(userId: string) {
    const audits = await this.prisma.postFraudAudit.findMany({ where: { userId } });

    if (audits.length === 0) {
      return {
        totalCases: 0,
        breakdown: { open: 0, closed: 0 },
        totalReported: '0',
        totalRecovered: '0',
        recoveryRate: 0,
        analyticsLevel: 'no_data',
      };
    }

    const breakdown = { open: 0, closed: 0 };
    let totalReported = BigInt(0);
    let totalRecovered = BigInt(0);

    for (const a of audits as any[]) {
      if (a.status === 'OPEN') breakdown.open++;
      else breakdown.closed++;
      totalReported += a.reportedAmount as bigint;
      totalRecovered += (a.totalRecovered as bigint) || BigInt(0);
    }

    const recoveryRate = totalReported > BigInt(0)
      ? Math.round((Number(totalRecovered) / Number(totalReported)) * 100)
      : 0;

    let analyticsLevel: string;
    if (audits.length === 0) analyticsLevel = 'no_data';
    else if (recoveryRate >= 70) analyticsLevel = 'strong_recovery';
    else if (recoveryRate >= 40) analyticsLevel = 'partial_recovery';
    else analyticsLevel = 'low_recovery';

    return {
      totalCases: audits.length,
      breakdown,
      totalReported: totalReported.toString(),
      totalRecovered: totalRecovered.toString(),
      recoveryRate,
      analyticsLevel,
    };
  }
}
