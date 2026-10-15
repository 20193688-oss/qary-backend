import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class ApprovalWorkflowService {
  constructor(private prisma: PrismaClient) {}

  async createRequest(userId: string, data: {
    requestType: string;
    resourceType: string;
    resourceId: string;
    amount?: bigint;
    currency?: string;
    description: string;
    requiredApprovals?: number;
  }) {
    return this.prisma.approvalRequest.create({
      data: {
        userId,
        requestType: data.requestType,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        amount: data.amount || null,
        currency: data.currency?.toUpperCase() || null,
        description: data.description,
        requiredApprovals: data.requiredApprovals || 1,
        currentApprovals: 0,
        status: 'PENDING',
        reference: `APR-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getRequests(userId: string) {
    return this.prisma.approvalRequest.findMany({ where: { userId } });
  }

  async getRequest(userId: string, id: string) {
    const request = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!request) throw new Error('request_not_found');
    if ((request as any).userId !== userId) throw new Error('request_not_found');
    return request;
  }

  async approve(userId: string, id: string, approverNotes?: string) {
    const request = await this.getRequest(userId, id);
    if ((request as any).status !== 'PENDING') throw new Error('request_not_pending');

    const newApprovals = ((request as any).currentApprovals || 0) + 1;
    const required = (request as any).requiredApprovals || 1;
    const newStatus = newApprovals >= required ? 'APPROVED' : 'PENDING';

    return this.prisma.approvalRequest.update({
      where: { id },
      data: {
        currentApprovals: newApprovals,
        status: newStatus,
        approverNotes: approverNotes || null,
        ...(newStatus === 'APPROVED' ? { approvedAt: new Date() } : {}),
      },
    });
  }

  async reject(userId: string, id: string, reason: string) {
    const request = await this.getRequest(userId, id);
    if ((request as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.approvalRequest.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason, rejectedAt: new Date() },
    });
  }

  async cancel(userId: string, id: string) {
    const request = await this.getRequest(userId, id);
    if ((request as any).status !== 'PENDING') throw new Error('request_not_pending');

    return this.prisma.approvalRequest.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getApprovalAnalytics(userId: string) {
    const requests = await this.prisma.approvalRequest.findMany({ where: { userId } });

    if (requests.length === 0) {
      return {
        totalRequests: 0,
        breakdown: { pending: 0, approved: 0, rejected: 0, cancelled: 0 },
        approvalRate: 0,
        analyticsLevel: 'no_data',
      };
    }

    const breakdown = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const r of requests as any[]) {
      const status = r.status.toLowerCase() as keyof typeof breakdown;
      if (status in breakdown) breakdown[status]++;
    }

    const decided = breakdown.approved + breakdown.rejected;
    const approvalRate = decided > 0 ? Math.round((breakdown.approved / decided) * 100) : 0;

    return {
      totalRequests: requests.length,
      breakdown,
      approvalRate,
      analyticsLevel: requests.length >= 5 ? 'sufficient' : 'limited',
    };
  }
}
