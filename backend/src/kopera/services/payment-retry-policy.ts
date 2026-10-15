import type { PrismaClient } from '@prisma/client';

export class PaymentRetryPolicyService {
  constructor(private prisma: PrismaClient) {}

  async createPolicy(userId: string, data: {
    name: string;
    maxRetries: number;
    retryIntervalMinutes: number;
    backoffMultiplier: number;
    applicableMethods: string;
  }) {
    const existing = await this.prisma.paymentRetryPolicy.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('policy_name_duplicate');
    return this.prisma.paymentRetryPolicy.create({
      data: {
        userId,
        name: data.name,
        maxRetries: data.maxRetries,
        retryIntervalMinutes: data.retryIntervalMinutes,
        backoffMultiplier: data.backoffMultiplier,
        applicableMethods: data.applicableMethods.toUpperCase(),
        isActive: true,
        totalRetries: 0,
        successfulRetries: 0,
        failedRetries: 0,
      },
    });
  }

  async getPolicies(userId: string) {
    return this.prisma.paymentRetryPolicy.findMany({ where: { userId } });
  }

  async getPolicy(userId: string, id: string) {
    const p = await this.prisma.paymentRetryPolicy.findFirst({ where: { id, userId } });
    if (!p) throw new Error('policy_not_found');
    return p;
  }

  async recordRetry(userId: string, id: string, success: boolean) {
    const p = await this.prisma.paymentRetryPolicy.findFirst({ where: { id, userId } });
    if (!p) throw new Error('policy_not_found');
    if (!p.isActive) throw new Error('policy_not_active');
    return this.prisma.paymentRetryPolicy.update({
      where: { id },
      data: {
        totalRetries: p.totalRetries + 1,
        successfulRetries: success ? p.successfulRetries + 1 : p.successfulRetries,
        failedRetries: success ? p.failedRetries : p.failedRetries + 1,
        lastRetryAt: new Date(),
      },
    });
  }

  async togglePolicy(userId: string, id: string, active: boolean) {
    const p = await this.prisma.paymentRetryPolicy.findFirst({ where: { id, userId } });
    if (!p) throw new Error('policy_not_found');
    return this.prisma.paymentRetryPolicy.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deletePolicy(userId: string, id: string) {
    const p = await this.prisma.paymentRetryPolicy.findFirst({ where: { id, userId } });
    if (!p) throw new Error('policy_not_found');
    return this.prisma.paymentRetryPolicy.delete({ where: { id } });
  }

  async getPolicyAnalytics(userId: string) {
    const all = await this.prisma.paymentRetryPolicy.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalPolicies: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((p) => p.isActive).length;
    let totalRetries = 0;
    let successfulRetries = 0;
    let failedRetries = 0;
    for (const p of all) {
      totalRetries += p.totalRetries;
      successfulRetries += p.successfulRetries;
      failedRetries += p.failedRetries;
    }
    return {
      totalPolicies: all.length,
      activeCount,
      totalRetries,
      successfulRetries,
      failedRetries,
      successRate: totalRetries > 0 ? Math.round((successfulRetries / totalRetries) * 100) : 0,
      analyticsLevel: 'full' as const,
    };
  }
}
