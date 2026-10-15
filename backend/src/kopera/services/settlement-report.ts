import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class SettlementReportService {
  constructor(private prisma: PrismaClient) {}

  async createReport(userId: string, data: {
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    totalSettled: bigint;
    transactionCount: number;
  }) {
    return this.prisma.settlementReport.create({
      data: {
        userId,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        currency: data.currency.toUpperCase(),
        totalSettled: data.totalSettled,
        transactionCount: data.transactionCount,
        totalFees: BigInt(0),
        netAmount: data.totalSettled,
        status: 'GENERATED',
        reference: `SRP-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getReports(userId: string) {
    return this.prisma.settlementReport.findMany({ where: { userId } });
  }

  async getReport(userId: string, id: string) {
    const r = await this.prisma.settlementReport.findUnique({ where: { id } });
    if (!r) throw new Error('report_not_found');
    if ((r as any).userId !== userId) throw new Error('report_not_found');
    return r;
  }

  async finalizeReport(userId: string, id: string) {
    const r = await this.getReport(userId, id);
    if ((r as any).status !== 'GENERATED') throw new Error('report_not_generated');

    return this.prisma.settlementReport.update({
      where: { id },
      data: { status: 'FINALIZED', finalizedAt: new Date() },
    });
  }

  async archiveReport(userId: string, id: string) {
    const r = await this.getReport(userId, id);
    if ((r as any).status !== 'FINALIZED') throw new Error('report_not_finalized');

    return this.prisma.settlementReport.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  async getReportAnalytics(userId: string) {
    const reports = await this.prisma.settlementReport.findMany({ where: { userId } });

    if (reports.length === 0) {
      return {
        totalReports: 0,
        breakdown: { GENERATED: 0, FINALIZED: 0, ARCHIVED: 0 },
        totalSettled: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { GENERATED: 0, FINALIZED: 0, ARCHIVED: 0 };
    let totalSettled = BigInt(0);
    for (const r of reports as any[]) {
      if (r.status in breakdown) breakdown[r.status]++;
      totalSettled += (r.totalSettled || BigInt(0)) as bigint;
    }

    return {
      totalReports: reports.length,
      breakdown,
      totalSettled: totalSettled.toString(),
      analyticsLevel: reports.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
