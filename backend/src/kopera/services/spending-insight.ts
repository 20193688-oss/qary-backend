import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class SpendingInsightService {
  constructor(private prisma: PrismaClient) {}

  async generateInsight(userId: string, data: {
    period: string;
    category: string;
    totalSpent: bigint;
    transactionCount: number;
    averageAmount: bigint;
    currency: string;
    trend?: string;
    recommendation?: string;
  }) {
    return this.prisma.spendingInsight.create({
      data: {
        userId,
        period: data.period,
        category: data.category,
        totalSpent: data.totalSpent,
        transactionCount: data.transactionCount,
        averageAmount: data.averageAmount,
        currency: data.currency.toUpperCase(),
        trend: data.trend || 'STABLE',
        recommendation: data.recommendation || null,
        reference: `INS-${Date.now()}-${randomUUID().slice(0, 8)}`,
        generatedAt: new Date(),
      },
    });
  }

  async getInsights(userId: string) {
    return this.prisma.spendingInsight.findMany({ where: { userId } });
  }

  async getInsight(userId: string, id: string) {
    const insight = await this.prisma.spendingInsight.findUnique({ where: { id } });
    if (!insight) throw new Error('insight_not_found');
    if ((insight as any).userId !== userId) throw new Error('insight_not_found');
    return insight;
  }

  async getByPeriod(userId: string, period: string) {
    const insights = await this.prisma.spendingInsight.findMany({ where: { userId } });
    return (insights as any[]).filter((i) => i.period === period);
  }

  async getByCategory(userId: string, category: string) {
    const insights = await this.prisma.spendingInsight.findMany({ where: { userId } });
    return (insights as any[]).filter((i) => i.category === category);
  }

  async deleteInsight(userId: string, id: string) {
    await this.getInsight(userId, id);
    return this.prisma.spendingInsight.delete({ where: { id } });
  }

  async getInsightAnalytics(userId: string) {
    const insights = await this.prisma.spendingInsight.findMany({ where: { userId } });

    if (insights.length === 0) {
      return {
        totalInsights: 0,
        periods: [],
        categories: {},
        trends: { STABLE: 0, INCREASING: 0, DECREASING: 0 },
        analyticsLevel: 'no_data',
      };
    }

    const periods = new Set<string>();
    const categories: Record<string, number> = {};
    const trends: Record<string, number> = { STABLE: 0, INCREASING: 0, DECREASING: 0 };
    for (const i of insights as any[]) {
      periods.add(i.period);
      categories[i.category] = (categories[i.category] || 0) + 1;
      const t = i.trend as string;
      if (t in trends) trends[t]++;
    }

    return {
      totalInsights: insights.length,
      periods: [...periods],
      categories,
      trends,
      analyticsLevel: insights.length >= 5 ? 'sufficient' : 'limited',
    };
  }
}
