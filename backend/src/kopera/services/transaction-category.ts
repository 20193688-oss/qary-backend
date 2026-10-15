import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class TransactionCategoryService {
  constructor(private prisma: PrismaClient) {}

  async createCategory(userId: string, data: {
    name: string;
    icon: string;
    color: string;
    description?: string;
  }) {
    const existing = await this.prisma.transactionCategory.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('category_exists');

    return this.prisma.transactionCategory.create({
      data: {
        userId,
        name: data.name,
        icon: data.icon,
        color: data.color,
        description: data.description || null,
        transactionCount: 0,
        totalAmount: BigInt(0),
        isActive: true,
        reference: `TXC-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getCategories(userId: string) {
    return this.prisma.transactionCategory.findMany({ where: { userId } });
  }

  async getCategory(userId: string, id: string) {
    const c = await this.prisma.transactionCategory.findUnique({ where: { id } });
    if (!c) throw new Error('category_not_found');
    if ((c as any).userId !== userId) throw new Error('category_not_found');
    return c;
  }

  async categorizeTransaction(userId: string, id: string, amount: bigint) {
    const c = await this.getCategory(userId, id);
    if (!(c as any).isActive) throw new Error('category_not_active');

    return this.prisma.transactionCategory.update({
      where: { id },
      data: {
        transactionCount: ((c as any).transactionCount || 0) + 1,
        totalAmount: ((c as any).totalAmount || BigInt(0)) + amount,
        lastUsedAt: new Date(),
      },
    });
  }

  async toggleCategory(userId: string, id: string, active: boolean) {
    await this.getCategory(userId, id);
    return this.prisma.transactionCategory.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteCategory(userId: string, id: string) {
    await this.getCategory(userId, id);
    return this.prisma.transactionCategory.delete({ where: { id } });
  }

  async getCategoryAnalytics(userId: string) {
    const cats = await this.prisma.transactionCategory.findMany({ where: { userId } });

    if (cats.length === 0) {
      return {
        totalCategories: 0,
        activeCategories: 0,
        totalCategorized: 0,
        totalAmount: '0',
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalCategorized = 0;
    let totalAmount = BigInt(0);
    for (const c of cats as any[]) {
      if (c.isActive) activeCount++;
      totalCategorized += c.transactionCount || 0;
      totalAmount += (c.totalAmount || BigInt(0)) as bigint;
    }

    return {
      totalCategories: cats.length,
      activeCategories: activeCount,
      totalCategorized,
      totalAmount: totalAmount.toString(),
      analyticsLevel: cats.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
