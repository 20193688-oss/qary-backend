import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class TransactionExportService {
  constructor(private prisma: PrismaClient) {}

  async createExport(userId: string, data: {
    format: string;
    dateFrom: Date;
    dateTo: Date;
    currency?: string;
  }) {
    return this.prisma.transactionExport.create({
      data: {
        userId,
        format: data.format.toUpperCase(),
        dateFrom: data.dateFrom,
        dateTo: data.dateTo,
        currency: data.currency?.toUpperCase() || null,
        recordCount: 0,
        fileSize: 0,
        status: 'PENDING',
        reference: `TXE-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getExports(userId: string) {
    return this.prisma.transactionExport.findMany({ where: { userId } });
  }

  async getExport(userId: string, id: string) {
    const e = await this.prisma.transactionExport.findUnique({ where: { id } });
    if (!e) throw new Error('export_not_found');
    if ((e as any).userId !== userId) throw new Error('export_not_found');
    return e;
  }

  async processExport(userId: string, id: string, recordCount: number, fileSize: number) {
    const e = await this.getExport(userId, id);
    if ((e as any).status !== 'PENDING') throw new Error('export_not_pending');

    return this.prisma.transactionExport.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        recordCount,
        fileSize,
        completedAt: new Date(),
      },
    });
  }

  async downloadExport(userId: string, id: string) {
    const e = await this.getExport(userId, id);
    if ((e as any).status !== 'COMPLETED') throw new Error('export_not_completed');

    return this.prisma.transactionExport.update({
      where: { id },
      data: {
        downloadCount: ((e as any).downloadCount || 0) + 1,
        lastDownloadedAt: new Date(),
      },
    });
  }

  async cancelExport(userId: string, id: string) {
    const e = await this.getExport(userId, id);
    if ((e as any).status !== 'PENDING') throw new Error('export_not_pending');

    return this.prisma.transactionExport.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getExportAnalytics(userId: string) {
    const exports = await this.prisma.transactionExport.findMany({ where: { userId } });

    if (exports.length === 0) {
      return {
        totalExports: 0,
        breakdown: { PENDING: 0, COMPLETED: 0, CANCELLED: 0 },
        totalRecords: 0,
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, COMPLETED: 0, CANCELLED: 0 };
    let totalRecords = 0;
    for (const e of exports as any[]) {
      if (e.status in breakdown) breakdown[e.status]++;
      totalRecords += e.recordCount || 0;
    }

    return {
      totalExports: exports.length,
      breakdown,
      totalRecords,
      analyticsLevel: exports.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
