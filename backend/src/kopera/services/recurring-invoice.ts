import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class RecurringInvoiceService {
  constructor(private prisma: PrismaClient) {}

  async createRecurring(userId: string, data: {
    recipientName: string;
    recipientEmail: string;
    amount: bigint;
    currency: string;
    interval: string;
    description?: string;
    startDate: Date;
  }) {
    return this.prisma.recurringInvoice.create({
      data: {
        userId,
        recipientName: data.recipientName,
        recipientEmail: data.recipientEmail,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        interval: data.interval.toUpperCase(),
        description: data.description || null,
        startDate: data.startDate,
        nextDueDate: data.startDate,
        issuedCount: 0,
        status: 'ACTIVE',
        reference: `RIN-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getRecurrings(userId: string) {
    return this.prisma.recurringInvoice.findMany({ where: { userId } });
  }

  async getRecurring(userId: string, id: string) {
    const rec = await this.prisma.recurringInvoice.findUnique({ where: { id } });
    if (!rec) throw new Error('recurring_not_found');
    if ((rec as any).userId !== userId) throw new Error('recurring_not_found');
    return rec;
  }

  async issueNext(userId: string, id: string) {
    const rec = await this.getRecurring(userId, id);
    if ((rec as any).status !== 'ACTIVE') throw new Error('recurring_not_active');

    const nextDue = new Date((rec as any).nextDueDate);
    const interval = (rec as any).interval as string;
    if (interval === 'WEEKLY') nextDue.setDate(nextDue.getDate() + 7);
    else if (interval === 'MONTHLY') nextDue.setMonth(nextDue.getMonth() + 1);
    else if (interval === 'QUARTERLY') nextDue.setMonth(nextDue.getMonth() + 3);
    else nextDue.setFullYear(nextDue.getFullYear() + 1);

    return this.prisma.recurringInvoice.update({
      where: { id },
      data: {
        issuedCount: ((rec as any).issuedCount || 0) + 1,
        lastIssuedAt: new Date(),
        nextDueDate: nextDue,
      },
    });
  }

  async pauseRecurring(userId: string, id: string) {
    const rec = await this.getRecurring(userId, id);
    if ((rec as any).status !== 'ACTIVE') throw new Error('recurring_not_active');

    return this.prisma.recurringInvoice.update({
      where: { id },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
  }

  async resumeRecurring(userId: string, id: string) {
    const rec = await this.getRecurring(userId, id);
    if ((rec as any).status !== 'PAUSED') throw new Error('recurring_not_paused');

    return this.prisma.recurringInvoice.update({
      where: { id },
      data: { status: 'ACTIVE', pausedAt: null },
    });
  }

  async cancelRecurring(userId: string, id: string) {
    const rec = await this.getRecurring(userId, id);
    if ((rec as any).status === 'CANCELLED') throw new Error('recurring_already_cancelled');

    return this.prisma.recurringInvoice.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getRecurringAnalytics(userId: string) {
    const recs = await this.prisma.recurringInvoice.findMany({ where: { userId } });

    if (recs.length === 0) {
      return {
        totalRecurring: 0,
        breakdown: { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 },
        totalIssued: 0,
        intervals: {},
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 };
    let totalIssued = 0;
    const intervals: Record<string, number> = {};
    for (const r of recs as any[]) {
      const status = r.status as string;
      if (status in breakdown) breakdown[status]++;
      totalIssued += r.issuedCount || 0;
      intervals[r.interval] = (intervals[r.interval] || 0) + 1;
    }

    return {
      totalRecurring: recs.length,
      breakdown,
      totalIssued,
      intervals,
      analyticsLevel: recs.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
