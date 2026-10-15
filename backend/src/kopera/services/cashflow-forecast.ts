import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class CashflowForecastService {
  constructor(private prisma: PrismaClient) {}

  async createForecast(userId: string, data: {
    period: string;
    projectedInflow: bigint;
    projectedOutflow: bigint;
    currency: string;
    notes?: string;
  }) {
    const netFlow = data.projectedInflow - data.projectedOutflow;

    return this.prisma.cashflowForecast.create({
      data: {
        userId,
        period: data.period.toUpperCase(),
        projectedInflow: data.projectedInflow,
        projectedOutflow: data.projectedOutflow,
        netFlow,
        currency: data.currency.toUpperCase(),
        notes: data.notes || null,
        confidence: netFlow >= BigInt(0) ? 'POSITIVE' : 'NEGATIVE',
        status: 'DRAFT',
        reference: `CFR-${Date.now()}-${randomUUID().slice(0, 8)}`,
        forecastedAt: new Date(),
      },
    });
  }

  async getForecasts(userId: string) {
    return this.prisma.cashflowForecast.findMany({ where: { userId } });
  }

  async getForecast(userId: string, id: string) {
    const fc = await this.prisma.cashflowForecast.findUnique({ where: { id } });
    if (!fc) throw new Error('forecast_not_found');
    if ((fc as any).userId !== userId) throw new Error('forecast_not_found');
    return fc;
  }

  async finalizeForecast(userId: string, id: string) {
    const fc = await this.getForecast(userId, id);
    if ((fc as any).status !== 'DRAFT') throw new Error('forecast_not_draft');

    return this.prisma.cashflowForecast.update({
      where: { id },
      data: { status: 'FINALIZED', finalizedAt: new Date() },
    });
  }

  async archiveForecast(userId: string, id: string) {
    const fc = await this.getForecast(userId, id);
    if ((fc as any).status === 'ARCHIVED') throw new Error('forecast_already_archived');

    return this.prisma.cashflowForecast.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  async getByPeriod(userId: string, period: string) {
    return this.prisma.cashflowForecast.findMany({
      where: { userId, period: period.toUpperCase() },
    });
  }

  async deleteForecast(userId: string, id: string) {
    await this.getForecast(userId, id);
    return this.prisma.cashflowForecast.delete({ where: { id } });
  }

  async getForecastAnalytics(userId: string) {
    const forecasts = await this.prisma.cashflowForecast.findMany({ where: { userId } });

    if (forecasts.length === 0) {
      return {
        totalForecasts: 0,
        breakdown: { DRAFT: 0, FINALIZED: 0, ARCHIVED: 0 },
        totalInflow: '0',
        totalOutflow: '0',
        netPosition: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { DRAFT: 0, FINALIZED: 0, ARCHIVED: 0 };
    let totalInflow = BigInt(0);
    let totalOutflow = BigInt(0);
    for (const f of forecasts as any[]) {
      const status = f.status as string;
      if (status in breakdown) breakdown[status]++;
      totalInflow += f.projectedInflow as bigint;
      totalOutflow += f.projectedOutflow as bigint;
    }

    return {
      totalForecasts: forecasts.length,
      breakdown,
      totalInflow: totalInflow.toString(),
      totalOutflow: totalOutflow.toString(),
      netPosition: (totalInflow - totalOutflow).toString(),
      analyticsLevel: forecasts.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
