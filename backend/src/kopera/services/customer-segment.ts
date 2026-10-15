import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class CustomerSegmentService {
  constructor(private prisma: PrismaClient) {}

  async createSegment(userId: string, data: {
    name: string;
    criteria: string;
    description?: string;
  }) {
    const existing = await this.prisma.customerSegment.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('segment_exists');

    return this.prisma.customerSegment.create({
      data: {
        userId,
        name: data.name,
        criteria: data.criteria,
        description: data.description || null,
        memberCount: 0,
        isActive: true,
        reference: `SEG-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getSegments(userId: string) {
    return this.prisma.customerSegment.findMany({ where: { userId } });
  }

  async getSegment(userId: string, id: string) {
    const s = await this.prisma.customerSegment.findUnique({ where: { id } });
    if (!s) throw new Error('segment_not_found');
    if ((s as any).userId !== userId) throw new Error('segment_not_found');
    return s;
  }

  async addMembers(userId: string, id: string, count: number) {
    const s = await this.getSegment(userId, id);
    if (!(s as any).isActive) throw new Error('segment_not_active');

    return this.prisma.customerSegment.update({
      where: { id },
      data: {
        memberCount: ((s as any).memberCount || 0) + count,
        lastUpdatedAt: new Date(),
      },
    });
  }

  async toggleSegment(userId: string, id: string, active: boolean) {
    await this.getSegment(userId, id);
    return this.prisma.customerSegment.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteSegment(userId: string, id: string) {
    await this.getSegment(userId, id);
    return this.prisma.customerSegment.delete({ where: { id } });
  }

  async getSegmentAnalytics(userId: string) {
    const segments = await this.prisma.customerSegment.findMany({ where: { userId } });

    if (segments.length === 0) {
      return {
        totalSegments: 0,
        activeSegments: 0,
        totalMembers: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalMembers = 0;
    for (const s of segments as any[]) {
      if (s.isActive) activeCount++;
      totalMembers += s.memberCount || 0;
    }

    return {
      totalSegments: segments.length,
      activeSegments: activeCount,
      totalMembers,
      analyticsLevel: segments.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
