import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PayoutScheduleService {
  constructor(private prisma: PrismaClient) {}

  async createSchedule(userId: string, data: {
    recipientName: string;
    recipientAccount: string;
    amount: bigint;
    currency: string;
    frequency: string;
  }) {
    return this.prisma.payoutSchedule.create({
      data: {
        userId,
        recipientName: data.recipientName,
        recipientAccount: data.recipientAccount,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        frequency: data.frequency.toUpperCase(),
        executionCount: 0,
        totalPaid: BigInt(0),
        status: 'ACTIVE',
        reference: `POS-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getSchedules(userId: string) {
    return this.prisma.payoutSchedule.findMany({ where: { userId } });
  }

  async getSchedule(userId: string, id: string) {
    const s = await this.prisma.payoutSchedule.findUnique({ where: { id } });
    if (!s) throw new Error('schedule_not_found');
    if ((s as any).userId !== userId) throw new Error('schedule_not_found');
    return s;
  }

  async executePayout(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status !== 'ACTIVE') throw new Error('schedule_not_active');

    return this.prisma.payoutSchedule.update({
      where: { id },
      data: {
        executionCount: ((s as any).executionCount || 0) + 1,
        totalPaid: ((s as any).totalPaid || BigInt(0)) + ((s as any).amount as bigint),
        lastPaidAt: new Date(),
      },
    });
  }

  async pauseSchedule(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status !== 'ACTIVE') throw new Error('schedule_not_active');

    return this.prisma.payoutSchedule.update({
      where: { id },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
  }

  async resumeSchedule(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status !== 'PAUSED') throw new Error('schedule_not_paused');

    return this.prisma.payoutSchedule.update({
      where: { id },
      data: { status: 'ACTIVE', pausedAt: null },
    });
  }

  async cancelSchedule(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status === 'CANCELLED') throw new Error('schedule_already_cancelled');

    return this.prisma.payoutSchedule.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getPayoutAnalytics(userId: string) {
    const schedules = await this.prisma.payoutSchedule.findMany({ where: { userId } });

    if (schedules.length === 0) {
      return {
        totalSchedules: 0,
        breakdown: { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 },
        totalPaid: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 };
    let totalPaid = BigInt(0);
    for (const s of schedules as any[]) {
      if (s.status in breakdown) breakdown[s.status]++;
      totalPaid += (s.totalPaid || BigInt(0)) as bigint;
    }

    return {
      totalSchedules: schedules.length,
      breakdown,
      totalPaid: totalPaid.toString(),
      analyticsLevel: schedules.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
