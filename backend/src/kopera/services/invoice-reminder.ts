import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class InvoiceReminderService {
  constructor(private prisma: PrismaClient) {}

  async createReminder(userId: string, data: {
    invoiceId: string;
    recipientEmail: string;
    message: string;
    sendAt: Date;
  }) {
    return this.prisma.invoiceReminder.create({
      data: {
        userId,
        invoiceId: data.invoiceId,
        recipientEmail: data.recipientEmail,
        message: data.message,
        sendAt: data.sendAt,
        status: 'SCHEDULED',
        reference: `IRM-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getReminders(userId: string) {
    return this.prisma.invoiceReminder.findMany({ where: { userId } });
  }

  async getReminder(userId: string, id: string) {
    const r = await this.prisma.invoiceReminder.findUnique({ where: { id } });
    if (!r) throw new Error('reminder_not_found');
    if ((r as any).userId !== userId) throw new Error('reminder_not_found');
    return r;
  }

  async sendReminder(userId: string, id: string) {
    const r = await this.getReminder(userId, id);
    if ((r as any).status !== 'SCHEDULED') throw new Error('reminder_not_scheduled');

    return this.prisma.invoiceReminder.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date() },
    });
  }

  async cancelReminder(userId: string, id: string) {
    const r = await this.getReminder(userId, id);
    if ((r as any).status !== 'SCHEDULED') throw new Error('reminder_not_scheduled');

    return this.prisma.invoiceReminder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getReminderAnalytics(userId: string) {
    const reminders = await this.prisma.invoiceReminder.findMany({ where: { userId } });

    if (reminders.length === 0) {
      return {
        totalReminders: 0,
        breakdown: { SCHEDULED: 0, SENT: 0, CANCELLED: 0 },
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { SCHEDULED: 0, SENT: 0, CANCELLED: 0 };
    for (const r of reminders as any[]) {
      if (r.status in breakdown) breakdown[r.status]++;
    }

    return {
      totalReminders: reminders.length,
      breakdown,
      analyticsLevel: reminders.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
