import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentRequestService {
  constructor(private prisma: PrismaClient) {}

  async createRequest(userId: string, data: {
    payerName: string;
    payerEmail: string;
    amount: bigint;
    currency: string;
    description: string;
    expiresAt?: Date;
  }) {
    return this.prisma.paymentRequest.create({
      data: {
        userId,
        payerName: data.payerName,
        payerEmail: data.payerEmail,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        description: data.description,
        status: 'PENDING',
        expiresAt: data.expiresAt || null,
        reference: `PRQ-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getRequests(userId: string) {
    return this.prisma.paymentRequest.findMany({ where: { userId } });
  }

  async getRequest(userId: string, id: string) {
    const r = await this.prisma.paymentRequest.findUnique({ where: { id } });
    if (!r) throw new Error('payment_request_not_found');
    if ((r as any).userId !== userId) throw new Error('payment_request_not_found');
    return r;
  }

  async markPaid(userId: string, id: string) {
    const r = await this.getRequest(userId, id);
    if ((r as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.paymentRequest.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    });
  }

  async declineRequest(userId: string, id: string) {
    const r = await this.getRequest(userId, id);
    if ((r as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.paymentRequest.update({
      where: { id },
      data: { status: 'DECLINED', declinedAt: new Date() },
    });
  }

  async cancelRequest(userId: string, id: string) {
    const r = await this.getRequest(userId, id);
    if ((r as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.paymentRequest.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async remindPayer(userId: string, id: string) {
    const r = await this.getRequest(userId, id);
    if ((r as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.paymentRequest.update({
      where: { id },
      data: { reminderCount: ((r as any).reminderCount || 0) + 1, lastRemindedAt: new Date() },
    });
  }

  async getRequestAnalytics(userId: string) {
    const requests = await this.prisma.paymentRequest.findMany({ where: { userId } });

    if (requests.length === 0) {
      return {
        totalRequests: 0,
        breakdown: { PENDING: 0, PAID: 0, DECLINED: 0, CANCELLED: 0 },
        totalAmount: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, PAID: 0, DECLINED: 0, CANCELLED: 0 };
    let totalAmount = BigInt(0);
    for (const r of requests as any[]) {
      const status = r.status as string;
      if (status in breakdown) breakdown[status]++;
      totalAmount += r.amount as bigint;
    }

    return {
      totalRequests: requests.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      analyticsLevel: requests.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
