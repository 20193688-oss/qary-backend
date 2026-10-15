import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class BudgetCategoryService {
  constructor(private prisma: PrismaClient) {}

  async createCategory(userId: string, data: {
    name: string;
    budgetLimit: bigint;
    currency: string;
    period: string;
    description?: string;
  }) {
    const existing = await this.prisma.budgetCategory.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('budget_category_exists');

    return this.prisma.budgetCategory.create({
      data: {
        userId,
        name: data.name,
        budgetLimit: data.budgetLimit,
        currentSpend: BigInt(0),
        currency: data.currency.toUpperCase(),
        period: data.period.toUpperCase(),
        description: data.description || null,
        isActive: true,
        reference: `BCAT-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getCategories(userId: string) {
    return this.prisma.budgetCategory.findMany({ where: { userId } });
  }

  async getCategory(userId: string, id: string) {
    const cat = await this.prisma.budgetCategory.findUnique({ where: { id } });
    if (!cat) throw new Error('budget_category_not_found');
    if ((cat as any).userId !== userId) throw new Error('budget_category_not_found');
    return cat;
  }

  async recordSpend(userId: string, id: string, amount: bigint) {
    const cat = await this.getCategory(userId, id);
    const newSpend = ((cat as any).currentSpend as bigint) + amount;
    const overBudget = newSpend > ((cat as any).budgetLimit as bigint);

    return this.prisma.budgetCategory.update({
      where: { id },
      data: { currentSpend: newSpend, overBudget, lastSpendAt: new Date() },
    });
  }

  async resetSpend(userId: string, id: string) {
    await this.getCategory(userId, id);
    return this.prisma.budgetCategory.update({
      where: { id },
      data: { currentSpend: BigInt(0), overBudget: false },
    });
  }

  async updateLimit(userId: string, id: string, budgetLimit: bigint) {
    const cat = await this.getCategory(userId, id);
    const overBudget = ((cat as any).currentSpend as bigint) > budgetLimit;
    return this.prisma.budgetCategory.update({
      where: { id },
      data: { budgetLimit, overBudget },
    });
  }

  async deleteCategory(userId: string, id: string) {
    await this.getCategory(userId, id);
    return this.prisma.budgetCategory.delete({ where: { id } });
  }

  async getBudgetAnalytics(userId: string) {
    const cats = await this.prisma.budgetCategory.findMany({ where: { userId } });

    if (cats.length === 0) {
      return {
        totalCategories: 0,
        activeCategories: 0,
        overBudgetCount: 0,
        totalBudget: '0',
        totalSpend: '0',
        analyticsLevel: 'no_data',
      };
    }

    let totalBudget = BigInt(0);
    let totalSpend = BigInt(0);
    let overBudgetCount = 0;
    let activeCount = 0;
    for (const c of cats as any[]) {
      totalBudget += c.budgetLimit as bigint;
      totalSpend += c.currentSpend as bigint;
      if (c.overBudget) overBudgetCount++;
      if (c.isActive) activeCount++;
    }

    return {
      totalCategories: cats.length,
      activeCategories: activeCount,
      overBudgetCount,
      totalBudget: totalBudget.toString(),
      totalSpend: totalSpend.toString(),
      analyticsLevel: cats.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
