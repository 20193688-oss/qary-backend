import type { PrismaClient } from '@prisma/client';

const INTERVAL_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

export class SubscriptionService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    planName: string;
    amount: bigint;
    currency: string;
    interval: string;
    intervalCount?: number;
    merchantId?: string;
    metadata?: Record<string, unknown>;
  }) {
    const interval = params.interval.toLowerCase();
    if (!INTERVAL_MS[interval]) throw new Error('invalid_interval');

    const intervalCount = params.intervalCount ?? 1;
    const periodMs = INTERVAL_MS[interval]! * intervalCount;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + periodMs);

    return this.prisma.subscription.create({
      data: {
        userId: params.userId,
        merchantId: params.merchantId,
        planName: params.planName,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        interval,
        intervalCount,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        metadata: params.metadata as any,
      },
    });
  }

  async getById(subscriptionId: string) {
    return this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
  }

  async listByUser(userId: string) {
    return this.prisma.subscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancel(subscriptionId: string, userId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new Error('subscription_not_found');
    if (sub.userId !== userId) throw new Error('forbidden');
    if (sub.status === 'cancelled') throw new Error('already_cancelled');

    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
  }

  async pause(subscriptionId: string, userId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new Error('subscription_not_found');
    if (sub.userId !== userId) throw new Error('forbidden');
    if (sub.status !== 'active') throw new Error('not_active');

    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'paused' },
    });
  }

  async resume(subscriptionId: string, userId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new Error('subscription_not_found');
    if (sub.userId !== userId) throw new Error('forbidden');
    if (sub.status !== 'paused') throw new Error('not_paused');

    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'active' },
    });
  }
}
