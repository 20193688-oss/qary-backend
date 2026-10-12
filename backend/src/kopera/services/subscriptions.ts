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

    const interval = sub.interval as string;
    const intervalCount = sub.intervalCount ?? 1;
    const periodMs = (INTERVAL_MS[interval] ?? INTERVAL_MS['monthly']!) * intervalCount;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + periodMs);

    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        retryCount: 0,
      },
    });
  }

  async updatePlan(subscriptionId: string, userId: string, planName: string, amount: bigint) {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new Error('subscription_not_found');
    if (sub.userId !== userId) throw new Error('forbidden');
    if (sub.status === 'cancelled') throw new Error('already_cancelled');

    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { planName, amount },
    });
  }

  async processDueBillings() {
    const now = new Date();
    const due = await this.prisma.subscription.findMany({
      where: { status: 'active', nextBillingDate: { lte: now } },
    });

    const results: Array<{ subscriptionId: string; success: boolean; reason?: string }> = [];

    for (const sub of due) {
      const wallet = await this.prisma.wallet.findFirst({
        where: { userId: sub.userId, currency: sub.currency, status: 'ACTIVE' },
      });

      if (!wallet || wallet.balance < sub.amount) {
        const newRetryCount = (sub.retryCount ?? 0) + 1;
        const maxRetries = sub.maxRetries ?? 3;

        if (newRetryCount >= maxRetries) {
          await this.prisma.subscription.update({
            where: { id: sub.id },
            data: { status: 'past_due', retryCount: newRetryCount },
          });
          results.push({ subscriptionId: sub.id, success: false, reason: 'max_retries_exceeded' });
        } else {
          await this.prisma.subscription.update({
            where: { id: sub.id },
            data: { retryCount: newRetryCount },
          });
          results.push({ subscriptionId: sub.id, success: false, reason: 'insufficient_funds' });
        }
        continue;
      }

      const interval = sub.interval as string;
      const intervalCount = sub.intervalCount ?? 1;
      const periodMs = (INTERVAL_MS[interval] ?? INTERVAL_MS['monthly']!) * intervalCount;
      const newPeriodStart = new Date(now.getTime());
      const newPeriodEnd = new Date(now.getTime() + periodMs);

      await this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: wallet.balance - sub.amount },
      });

      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: {
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
          nextBillingDate: newPeriodEnd,
          retryCount: 0,
        },
      });

      results.push({ subscriptionId: sub.id, success: true });
    }

    return { processed: results.length, results };
  }
}
