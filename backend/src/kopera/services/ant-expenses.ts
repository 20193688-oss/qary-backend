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
