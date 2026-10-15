import type { PrismaClient } from '@prisma/client';

export class PaymentReconciliationService {
  constructor(private prisma: PrismaClient) {}

  async createReconciliation(userId: string, data: {
    periodStart: string;
    periodEnd: string;
    currency: string;
    source: string;
  }) {
    return this.prisma.paymentReconciliation.create({
      data: {
        userId,
        periodStart: new Date(data.periodStart),
        periodEnd: new Date(data.periodEnd),
        currency: data.currency.toUpperCase(),
        source: data.source.toUpperCase(),
        status: 'PENDING',
        matchedCount: 0,
        unmatchedCount: 0,
        totalExpected: BigInt(0),
        totalActual: BigInt(0),
        discrepancy: BigInt(0),
      },
    });
  }

  async getReconciliations(userId: string) {
    return this.prisma.paymentReconciliation.findMany({ where: { userId } });
  }

  async getReconciliation(userId: string, id: string) {
    const r = await this.prisma.paymentReconciliation.findFirst({ where: { id, userId } });
    if (!r) throw new Error('reconciliation_not_found');
    return r;
  }

  async processReconciliation(userId: string, id: string, data: {
    matchedCount: number;
    unmatchedCount: number;
    totalExpected: bigint;
    totalActual: bigint;
  }) {
    const r = await this.prisma.paymentReconciliation.findFirst({ where: { id, userId } });
    if (!r) throw new Error('reconciliation_not_found');
    if (r.status !== 'PENDING') throw new Error('reconciliation_not_pending');
    const discrepancy = data.totalActual > data.totalExpected
      ? data.totalActual - data.totalExpected
      : data.totalExpected - data.totalActual;
    return this.prisma.paymentReconciliation.update({
      where: { id },
      data: {
        status: 'PROCESSED',
        matchedCount: data.matchedCount,
        unmatchedCount: data.unmatchedCount,
        totalExpected: data.totalExpected,
        totalActual: data.totalActual,
        discrepancy,
        processedAt: new Date(),
      },
    });
  }

  async approveReconciliation(userId: string, id: string) {
    const r = await this.prisma.paymentReconciliation.findFirst({ where: { id, userId } });
    if (!r) throw new Error('reconciliation_not_found');
    if (r.status !== 'PROCESSED') throw new Error('reconciliation_not_processed');
    return this.prisma.paymentReconciliation.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
  }

  async rejectReconciliation(userId: string, id: string, reason: string) {
    const r = await this.prisma.paymentReconciliation.findFirst({ where: { id, userId } });
    if (!r) throw new Error('reconciliation_not_found');
    if (r.status !== 'PROCESSED') throw new Error('reconciliation_not_processed');
    return this.prisma.paymentReconciliation.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: reason },
    });
  }

  async getReconciliationAnalytics(userId: string) {
    const all = await this.prisma.paymentReconciliation.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalReconciliations: 0, analyticsLevel: 'no_data' as const };
    }
    const byStatus: Record<string, number> = {};
    let totalDiscrepancy = BigInt(0);
    for (const r of all) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      totalDiscrepancy += r.discrepancy ?? BigInt(0);
    }
    return {
      totalReconciliations: all.length,
      byStatus,
      totalDiscrepancy: totalDiscrepancy.toString(),
      analyticsLevel: 'full' as const,
    };
  }
}
