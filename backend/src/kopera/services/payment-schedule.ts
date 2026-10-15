import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentScheduleService {
  constructor(private prisma: PrismaClient) {}

  async createSchedule(userId: string, data: {
    name: string;
    recipientName: string;
    recipientAccount: string;
    amount: bigint;
    currency: string;
    frequency: string;
    startDate: Date;
    installments: number;
  }) {
    return this.prisma.paymentSchedule.create({
      data: {
        userId,
        name: data.name,
        recipientName: data.recipientName,
        recipientAccount: data.recipientAccount,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        frequency: data.frequency.toUpperCase(),
        startDate: data.startDate,
        totalInstallments: data.installments,
        completedInstallments: 0,
        totalPaid: BigInt(0),
        status: 'ACTIVE',
        nextPaymentDate: data.startDate,
        reference: `PSC-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getSchedules(userId: string) {
    return this.prisma.paymentSchedule.findMany({ where: { userId } });
  }

  async getSchedule(userId: string, id: string) {
    const s = await this.prisma.paymentSchedule.findUnique({ where: { id } });
    if (!s) throw new Error('schedule_not_found');
    if ((s as any).userId !== userId) throw new Error('schedule_not_found');
    return s;
  }

  async executeInstallment(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status !== 'ACTIVE') throw new Error('schedule_not_active');
    const completed = ((s as any).completedInstallments || 0) + 1;
    const total = (s as any).totalInstallments;
    const newStatus = completed >= total ? 'COMPLETED' : 'ACTIVE';

    return this.prisma.paymentSchedule.update({
      where: { id },
      data: {
        completedInstallments: completed,
        totalPaid: ((s as any).totalPaid || BigInt(0)) + ((s as any).amount as bigint),
        status: newStatus,
        lastPaymentDate: new Date(),
        completedAt: newStatus === 'COMPLETED' ? new Date() : undefined,
      },
    });
  }

  async pauseSchedule(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status !== 'ACTIVE') throw new Error('schedule_not_active');

    return this.prisma.paymentSchedule.update({
      where: { id },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
  }

  async resumeSchedule(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status !== 'PAUSED') throw new Error('schedule_not_paused');

    return this.prisma.paymentSchedule.update({
      where: { id },
      data: { status: 'ACTIVE', pausedAt: null },
    });
  }

  async cancelSchedule(userId: string, id: string) {
    const s = await this.getSchedule(userId, id);
    if ((s as any).status === 'COMPLETED') throw new Error('schedule_already_completed');
    if ((s as any).status === 'CANCELLED') throw new Error('schedule_already_cancelled');

    return this.prisma.paymentSchedule.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getScheduleAnalytics(userId: string) {
    const schedules = await this.prisma.paymentSchedule.findMany({ where: { userId } });

    if (schedules.length === 0) {
      return {
        totalSchedules: 0,
        breakdown: { ACTIVE: 0, PAUSED: 0, COMPLETED: 0, CANCELLED: 0 },
        totalPaid: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ACTIVE: 0, PAUSED: 0, COMPLETED: 0, CANCELLED: 0 };
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
