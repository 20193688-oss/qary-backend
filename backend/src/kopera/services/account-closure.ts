import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class AccountClosureService {
  constructor(private prisma: PrismaClient) {}

  async createRequest(userId: string, data: {
    reason: string;
    feedbackMessage?: string;
  }) {
    return this.prisma.accountClosure.create({
      data: {
        userId,
        reason: data.reason,
        feedbackMessage: data.feedbackMessage || null,
        status: 'PENDING',
        reference: `ACL-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getRequests(userId: string) {
    return this.prisma.accountClosure.findMany({ where: { userId } });
  }

  async getRequest(userId: string, id: string) {
    const r = await this.prisma.accountClosure.findUnique({ where: { id } });
    if (!r) throw new Error('request_not_found');
    if ((r as any).userId !== userId) throw new Error('request_not_found');
    return r;
  }

  async approveRequest(userId: string, id: string) {
    const r = await this.getRequest(userId, id);
    if ((r as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.accountClosure.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
  }

  async processRequest(userId: string, id: string) {
    const r = await this.getRequest(userId, id);
    if ((r as any).status !== 'APPROVED') throw new Error('request_not_approved');

    return this.prisma.accountClosure.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  }

  async cancelRequest(userId: string, id: string) {
    const r = await this.getRequest(userId, id);
    if ((r as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.accountClosure.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getClosureAnalytics(userId: string) {
    const requests = await this.prisma.accountClosure.findMany({ where: { userId } });

    if (requests.length === 0) {
      return {
        totalRequests: 0,
        breakdown: { PENDING: 0, APPROVED: 0, CLOSED: 0, CANCELLED: 0 },
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, APPROVED: 0, CLOSED: 0, CANCELLED: 0 };
    for (const r of requests as any[]) {
      if (r.status in breakdown) breakdown[r.status]++;
    }

    return {
      totalRequests: requests.length,
      breakdown,
      analyticsLevel: requests.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
