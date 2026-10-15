import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class ComplianceReportService {
  constructor(private prisma: PrismaClient) {}

  async generateReport(userId: string, data: {
    reportType: string;
    periodStart: Date;
    periodEnd: Date;
    currency?: string;
  }) {
    const transactions = await this.prisma.transaction.findMany({
      where: { userId },
    });
    const filtered = (transactions as any[]).filter((t) => {
      const d = new Date(t.createdAt);
      return d >= data.periodStart && d <= data.periodEnd;
    });

    const totalVolume = filtered.reduce(
      (s: bigint, t: any) => s + ((t.amount as bigint) || BigInt(0)), BigInt(0),
    );
    const txCount = filtered.length;
    const highValueCount = filtered.filter(
      (t: any) => ((t.amount as bigint) || BigInt(0)) > BigInt(1000000),
    ).length;

    let riskFlag: string;
    if (highValueCount === 0) riskFlag = 'LOW';
    else if (highValueCount <= 3) riskFlag = 'MEDIUM';
    else riskFlag = 'HIGH';

    return this.prisma.complianceReport.create({
      data: {
        userId,
        reportType: data.reportType,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        currency: data.currency?.toUpperCase() || 'USD',
        transactionCount: txCount,
        totalVolume,
        highValueTransactions: highValueCount,
        riskFlag,
        status: 'COMPLETED',
        reference: `CMP-${Date.now()}-${randomUUID().slice(0, 8)}`,
        generatedAt: new Date(),
      },
    });
  }

  async getReports(userId: string) {
    return this.prisma.complianceReport.findMany({ where: { userId } });
  }

  async getReport(userId: string, id: string) {
    const report = await this.prisma.complianceReport.findUnique({ where: { id } });
    if (!report) throw new Error('report_not_found');
    if ((report as any).userId !== userId) throw new Error('report_not_found');
    return report;
  }

  async flagReport(userId: string, id: string, notes: string) {
    const report = await this.getReport(userId, id);
    if ((report as any).status === 'ARCHIVED') throw new Error('report_archived');

    return this.prisma.complianceReport.update({
      where: { id },
      data: { status: 'FLAGGED', reviewNotes: notes },
    });
  }

  async archiveReport(userId: string, id: string) {
    const report = await this.getReport(userId, id);
    if ((report as any).status === 'ARCHIVED') throw new Error('report_already_archived');

    return this.prisma.complianceReport.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  async getComplianceSummary(userId: string) {
    const reports = await this.prisma.complianceReport.findMany({ where: { userId } });

    if (reports.length === 0) {
      return {
        totalReports: 0,
        breakdown: { completed: 0, flagged: 0, archived: 0 },
        riskBreakdown: { low: 0, medium: 0, high: 0 },
        totalVolume: '0',
        complianceLevel: 'no_data',
      };
    }

    const breakdown = { completed: 0, flagged: 0, archived: 0 };
    const riskBreakdown = { low: 0, medium: 0, high: 0 };
    let totalVolume = BigInt(0);

    for (const r of reports as any[]) {
      const status = r.status.toLowerCase() as keyof typeof breakdown;
      if (status in breakdown) breakdown[status]++;
      const risk = r.riskFlag.toLowerCase() as keyof typeof riskBreakdown;
      if (risk in riskBreakdown) riskBreakdown[risk]++;
      totalVolume += (r.totalVolume as bigint) || BigInt(0);
    }

    const highRiskRatio = reports.length > 0
      ? riskBreakdown.high / reports.length
      : 0;

    let complianceLevel: string;
    if (highRiskRatio === 0) complianceLevel = 'excellent';
    else if (highRiskRatio < 0.1) complianceLevel = 'good';
    else if (highRiskRatio < 0.3) complianceLevel = 'attention_needed';
    else complianceLevel = 'critical';

    return {
      totalReports: reports.length,
      breakdown,
      riskBreakdown,
      totalVolume: totalVolume.toString(),
      complianceLevel,
    };
  }
}
