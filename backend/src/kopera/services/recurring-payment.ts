import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class RecurringPaymentService {
  constructor(private prisma: PrismaClient) {}

  async createRecurring(userId: string, data: {
    recipientName: string;
    recipientAccount: string;
    amount: bigint;
    currency: string;
    frequency: string;
    description?: string;
  }) {
    return this.prisma.recurringPayment.create({
      data: {
        userId,
        recipientName: data.recipientName,
        recipientAccount: data.recipientAccount,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        frequency: data.frequency.toUpperCase(),
        description: data.description || null,
        executionCount: 0,
        totalPaid: BigInt(0),
        status: 'ACTIVE',
        nextPaymentDate: new Date(),
        reference: `RCP-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getRecurrings(userId: string) {
    return this.prisma.recurringPayment.findMany({ where: { userId } });
  }

  async getRecurring(userId: string, id: string) {
    const r = await this.prisma.recurringPayment.findUnique({ where: { id } });
    if (!r) throw new Error('recurring_payment_not_found');
    if ((r as any).userId !== userId) throw new Error('recurring_payment_not_found');
    return r;
  }

  async executePayment(userId: string, id: string) {
    const r = await this.getRecurring(userId, id);
    if ((r as any).status !== 'ACTIVE') throw new Error('payment_not_active');

    return this.prisma.recurringPayment.update({
      where: { id },
      data: {
        executionCount: ((r as any).executionCount || 0) + 1,
        totalPaid: ((r as any).totalPaid || BigInt(0)) + ((r as any).amount as bigint),
        lastPaymentDate: new Date(),
      },
    });
  }

  async pausePayment(userId: string, id: string) {
    const r = await this.getRecurring(userId, id);
    if ((r as any).status !== 'ACTIVE') throw new Error('payment_not_active');

    return this.prisma.recurringPayment.update({
      where: { id },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
  }

  async resumePayment(userId: string, id: string) {
    const r = await this.getRecurring(userId, id);
    if ((r as any).status !== 'PAUSED') throw new Error('payment_not_paused');

    return this.prisma.recurringPayment.update({
      where: { id },
      data: { status: 'ACTIVE', pausedAt: null },
    });
  }

  async cancelPayment(userId: string, id: string) {
    const r = await this.getRecurring(userId, id);
    if ((r as any).status === 'CANCELLED') throw new Error('payment_already_cancelled');

    return this.prisma.recurringPayment.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getRecurringAnalytics(userId: string) {
    const payments = await this.prisma.recurringPayment.findMany({ where: { userId } });

    if (payments.length === 0) {
      return {
        totalRecurrings: 0,
        breakdown: { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 },
        totalPaid: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 };
    let totalPaid = BigInt(0);
    for (const p of payments as any[]) {
      if (p.status in breakdown) breakdown[p.status]++;
      totalPaid += (p.totalPaid || BigInt(0)) as bigint;
    }

    return {
      totalRecurrings: payments.length,
      breakdown,
      totalPaid: totalPaid.toString(),
      analyticsLevel: payments.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
