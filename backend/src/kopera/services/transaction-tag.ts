import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class TransactionTagService {
  constructor(private prisma: PrismaClient) {}

  async createTag(userId: string, data: {
    name: string;
    color: string;
    description?: string;
  }) {
    const existing = await this.prisma.transactionTag.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('tag_exists');

    return this.prisma.transactionTag.create({
      data: {
        userId,
        name: data.name,
        color: data.color,
        description: data.description || null,
        usageCount: 0,
        isActive: true,
        reference: `TAG-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getTags(userId: string) {
    return this.prisma.transactionTag.findMany({ where: { userId } });
  }

  async getTag(userId: string, id: string) {
    const t = await this.prisma.transactionTag.findUnique({ where: { id } });
    if (!t) throw new Error('tag_not_found');
    if ((t as any).userId !== userId) throw new Error('tag_not_found');
    return t;
  }

  async applyTag(userId: string, id: string) {
    const t = await this.getTag(userId, id);
    if (!(t as any).isActive) throw new Error('tag_not_active');

    return this.prisma.transactionTag.update({
      where: { id },
      data: { usageCount: ((t as any).usageCount || 0) + 1, lastUsedAt: new Date() },
    });
  }

  async toggleTag(userId: string, id: string, active: boolean) {
    await this.getTag(userId, id);
    return this.prisma.transactionTag.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteTag(userId: string, id: string) {
    await this.getTag(userId, id);
    return this.prisma.transactionTag.delete({ where: { id } });
  }

  async getTagAnalytics(userId: string) {
    const tags = await this.prisma.transactionTag.findMany({ where: { userId } });

    if (tags.length === 0) {
      return {
        totalTags: 0,
        activeTags: 0,
        totalUsage: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalUsage = 0;
    for (const t of tags as any[]) {
      if (t.isActive) activeCount++;
      totalUsage += t.usageCount || 0;
    }

    return {
      totalTags: tags.length,
      activeTags: activeCount,
      totalUsage,
      analyticsLevel: tags.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
