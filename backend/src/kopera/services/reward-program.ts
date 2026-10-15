import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class RewardProgramService {
  constructor(private prisma: PrismaClient) {}

  async createProgram(userId: string, data: {
    name: string;
    programType: string;
    pointsPerUnit: number;
    currency: string;
    description?: string;
  }) {
    const existing = await this.prisma.rewardProgram.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('reward_program_exists');

    return this.prisma.rewardProgram.create({
      data: {
        userId,
        name: data.name,
        programType: data.programType.toUpperCase(),
        pointsPerUnit: data.pointsPerUnit,
        currency: data.currency.toUpperCase(),
        description: data.description || null,
        totalPointsIssued: 0,
        totalPointsRedeemed: 0,
        memberCount: 0,
        isActive: true,
        reference: `RWP-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getPrograms(userId: string) {
    return this.prisma.rewardProgram.findMany({ where: { userId } });
  }

  async getProgram(userId: string, id: string) {
    const p = await this.prisma.rewardProgram.findUnique({ where: { id } });
    if (!p) throw new Error('reward_program_not_found');
    if ((p as any).userId !== userId) throw new Error('reward_program_not_found');
    return p;
  }

  async issuePoints(userId: string, id: string, points: number) {
    const p = await this.getProgram(userId, id);
    if (!(p as any).isActive) throw new Error('program_not_active');

    return this.prisma.rewardProgram.update({
      where: { id },
      data: { totalPointsIssued: ((p as any).totalPointsIssued || 0) + points },
    });
  }

  async redeemPoints(userId: string, id: string, points: number) {
    const p = await this.getProgram(userId, id);
    if (!(p as any).isActive) throw new Error('program_not_active');

    const available = ((p as any).totalPointsIssued || 0) - ((p as any).totalPointsRedeemed || 0);
    if (points > available) throw new Error('insufficient_points');

    return this.prisma.rewardProgram.update({
      where: { id },
      data: { totalPointsRedeemed: ((p as any).totalPointsRedeemed || 0) + points },
    });
  }

  async toggleProgram(userId: string, id: string, active: boolean) {
    await this.getProgram(userId, id);
    return this.prisma.rewardProgram.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteProgram(userId: string, id: string) {
    await this.getProgram(userId, id);
    return this.prisma.rewardProgram.delete({ where: { id } });
  }

  async getRewardAnalytics(userId: string) {
    const programs = await this.prisma.rewardProgram.findMany({ where: { userId } });

    if (programs.length === 0) {
      return {
        totalPrograms: 0,
        activePrograms: 0,
        totalIssued: 0,
        totalRedeemed: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalIssued = 0;
    let totalRedeemed = 0;
    for (const p of programs as any[]) {
      if (p.isActive) activeCount++;
      totalIssued += p.totalPointsIssued || 0;
      totalRedeemed += p.totalPointsRedeemed || 0;
    }

    return {
      totalPrograms: programs.length,
      activePrograms: activeCount,
      totalIssued,
      totalRedeemed,
      analyticsLevel: programs.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
