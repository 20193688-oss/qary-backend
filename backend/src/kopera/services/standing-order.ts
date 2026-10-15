import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class StandingOrderService {
  constructor(private prisma: PrismaClient) {}

  async createOrder(userId: string, data: {
    recipientName: string;
    recipientAccount: string;
    amount: bigint;
    currency: string;
    frequency: string;
    startDate: Date;
    description?: string;
  }) {
    return this.prisma.standingOrder.create({
      data: {
        userId,
        recipientName: data.recipientName,
        recipientAccount: data.recipientAccount,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        frequency: data.frequency.toUpperCase(),
        description: data.description || null,
        startDate: data.startDate,
        nextExecutionDate: data.startDate,
        executionCount: 0,
        status: 'ACTIVE',
        reference: `STO-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getOrders(userId: string) {
    return this.prisma.standingOrder.findMany({ where: { userId } });
  }

  async getOrder(userId: string, id: string) {
    const o = await this.prisma.standingOrder.findUnique({ where: { id } });
    if (!o) throw new Error('standing_order_not_found');
    if ((o as any).userId !== userId) throw new Error('standing_order_not_found');
    return o;
  }

  async executeOrder(userId: string, id: string) {
    const o = await this.getOrder(userId, id);
    if ((o as any).status !== 'ACTIVE') throw new Error('order_not_active');

    const nextDate = new Date((o as any).nextExecutionDate);
    const freq = (o as any).frequency as string;
    if (freq === 'WEEKLY') nextDate.setDate(nextDate.getDate() + 7);
    else if (freq === 'MONTHLY') nextDate.setMonth(nextDate.getMonth() + 1);
    else if (freq === 'QUARTERLY') nextDate.setMonth(nextDate.getMonth() + 3);
    else nextDate.setFullYear(nextDate.getFullYear() + 1);

    return this.prisma.standingOrder.update({
      where: { id },
      data: {
        executionCount: ((o as any).executionCount || 0) + 1,
        lastExecutedAt: new Date(),
        nextExecutionDate: nextDate,
      },
    });
  }

  async pauseOrder(userId: string, id: string) {
    const o = await this.getOrder(userId, id);
    if ((o as any).status !== 'ACTIVE') throw new Error('order_not_active');

    return this.prisma.standingOrder.update({
      where: { id },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
  }

  async resumeOrder(userId: string, id: string) {
    const o = await this.getOrder(userId, id);
    if ((o as any).status !== 'PAUSED') throw new Error('order_not_paused');

    return this.prisma.standingOrder.update({
      where: { id },
      data: { status: 'ACTIVE', pausedAt: null },
    });
  }

  async cancelOrder(userId: string, id: string) {
    const o = await this.getOrder(userId, id);
    if ((o as any).status === 'CANCELLED') throw new Error('order_already_cancelled');

    return this.prisma.standingOrder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getOrderAnalytics(userId: string) {
    const orders = await this.prisma.standingOrder.findMany({ where: { userId } });

    if (orders.length === 0) {
      return {
        totalOrders: 0,
        breakdown: { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 },
        totalExecutions: 0,
        frequencies: {},
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 };
    let totalExecutions = 0;
    const frequencies: Record<string, number> = {};
    for (const o of orders as any[]) {
      const status = o.status as string;
      if (status in breakdown) breakdown[status]++;
      totalExecutions += o.executionCount || 0;
      frequencies[o.frequency] = (frequencies[o.frequency] || 0) + 1;
    }

    return {
      totalOrders: orders.length,
      breakdown,
      totalExecutions,
      frequencies,
      analyticsLevel: orders.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
