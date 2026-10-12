import type { PrismaClient } from '@prisma/client';

export class AntExpenseService {
  constructor(private prisma: PrismaClient) {}

  async detect(userId: string, data: {
    category: string;
    merchantName: string;
    amount: bigint;
    currency: string;
    frequency: string;
    monthlyTotal: bigint;
    yearlyProjection: bigint;
    suggestion?: string;
    savingsIfCut?: bigint;
  }) {
    const existing = await this.prisma.antExpense.findFirst({
      where: { userId, merchantName: data.merchantName, category: data.category, isActive: true },
    });
    if (existing) throw new Error('expense_already_tracked');

    return this.prisma.antExpense.create({
      data: { userId, ...data },
    });
  }

  async listActive(userId: string) {
    return this.prisma.antExpense.findMany({
      where: { userId, isActive: true },
    });
  }

  async getById(id: string) {
    return this.prisma.antExpense.findUnique({ where: { id } });
  }

  async getSummary(userId: string, currency: string) {
    const expenses = await this.prisma.antExpense.findMany({
      where: { userId, isActive: true, currency: currency.toUpperCase() },
    });

    let totalMonthly = BigInt(0);
    let totalYearly = BigInt(0);
    let totalSavingsIfCut = BigInt(0);

    for (const e of expenses) {
      totalMonthly += e.monthlyTotal;
      totalYearly += e.yearlyProjection;
      if (e.savingsIfCut) totalSavingsIfCut += e.savingsIfCut;
    }

    return {
      currency: currency.toUpperCase(),
      count: expenses.length,
      totalMonthly,
      totalYearly,
      totalSavingsIfCut,
    };
  }

  async reactivate(id: string, userId: string) {
    const expense = await this.prisma.antExpense.findUnique({ where: { id } });
    if (!expense) throw new Error('expense_not_found');
    if (expense.userId !== userId) throw new Error('forbidden');
    if (expense.isActive) throw new Error('already_active');

    return this.prisma.antExpense.update({
      where: { id },
      data: { isActive: true },
    });
  }

  async getCategoryBreakdown(userId: string, currency: string) {
    const expenses = await this.prisma.antExpense.findMany({
      where: { userId, isActive: true, currency: currency.toUpperCase() },
    });

    const categories: Record<string, { count: number; monthlyTotal: bigint; yearlyProjection: bigint }> = {};
    for (const e of expenses) {
      if (!categories[e.category]) {
        categories[e.category] = { count: 0, monthlyTotal: BigInt(0), yearlyProjection: BigInt(0) };
      }
      categories[e.category].count++;
      categories[e.category].monthlyTotal += e.monthlyTotal;
      categories[e.category].yearlyProjection += e.yearlyProjection;
    }

    return Object.entries(categories).map(([category, data]) => ({
      category,
      count: data.count,
      monthlyTotal: data.monthlyTotal,
      yearlyProjection: data.yearlyProjection,
    })).sort((a, b) => Number(b.monthlyTotal - a.monthlyTotal));
  }

  async listDismissed(userId: string) {
    return this.prisma.antExpense.findMany({
      where: { userId, isActive: false },
    });
  }

  async getSavingsImpactReport(userId: string) {
    const all = await this.prisma.antExpense.findMany({ where: { userId } });
    const active = all.filter((e: any) => e.isActive);
    const dismissed = all.filter((e: any) => !e.isActive);

    const byCurrency: Record<string, { monthlyTotal: bigint; potentialSavings: bigint; count: number }> = {};
    let highestImpact: { merchantName: string; category: string; currency: string; savingsIfCut: bigint } | null = null;

    for (const e of active) {
      if (!byCurrency[e.currency]) byCurrency[e.currency] = { monthlyTotal: BigInt(0), potentialSavings: BigInt(0), count: 0 };
      byCurrency[e.currency].monthlyTotal += e.monthlyTotal;
      byCurrency[e.currency].count++;
      if (e.savingsIfCut) {
        byCurrency[e.currency].potentialSavings += e.savingsIfCut;
        if (!highestImpact || e.savingsIfCut > highestImpact.savingsIfCut) {
          highestImpact = { merchantName: e.merchantName, category: e.category, currency: e.currency, savingsIfCut: e.savingsIfCut };
        }
      }
    }

    return {
      totalTracked: all.length,
      activeCount: active.length,
      dismissedCount: dismissed.length,
      byCurrency,
      highestImpact,
    };
  }

  async dismiss(id: string, userId: string) {
    const expense = await this.prisma.antExpense.findUnique({ where: { id } });
    if (!expense) throw new Error('expense_not_found');
    if (expense.userId !== userId) throw new Error('forbidden');
    if (!expense.isActive) throw new Error('already_dismissed');

    return this.prisma.antExpense.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
