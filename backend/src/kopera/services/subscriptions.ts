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

  async listByUser(userId: string, opts?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = { userId };
    if (opts?.status) where.status = opts.status;
    return this.prisma.subscription.findMany({
      where,
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
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

  async getSpendingSummary(userId: string) {
    const subs = await this.prisma.subscription.findMany({
      where: { userId, status: 'active' },
    });

    const byCurrency: Record<string, bigint> = {};
    const byStatus: Record<string, number> = {};
    let mostExpensive: { planName: string; amount: bigint; currency: string } | null = null;

    const allSubs = await this.prisma.subscription.findMany({ where: { userId } });
    for (const s of allSubs) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }

    const monthlyMultiplier: Record<string, number> = {
      daily: 30,
      weekly: 4,
      monthly: 1,
      yearly: 1,
    };
    const yearlyDivisor: Record<string, number> = {
      yearly: 12,
    };

    for (const s of subs) {
      const interval = s.interval as string;
      const intervalCount = s.intervalCount ?? 1;
      const mult = monthlyMultiplier[interval] ?? 1;
      const div = yearlyDivisor[interval] ?? 1;
      const monthlyAmount = (s.amount * BigInt(mult)) / (BigInt(intervalCount) * BigInt(div));

      byCurrency[s.currency] = (byCurrency[s.currency] ?? BigInt(0)) + monthlyAmount;

      if (!mostExpensive || s.amount > mostExpensive.amount) {
        mostExpensive = { planName: s.planName, amount: s.amount, currency: s.currency };
      }
    }

    return {
      activeCount: subs.length,
      byStatus,
      monthlyBurnByCurrency: byCurrency,
      mostExpensive,
    };
  }

  async getUpcomingBillings(userId: string, daysAhead = 30) {
    const cutoff = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    const subs = await this.prisma.subscription.findMany({
      where: { userId, status: 'active' },
    });

    const upcoming = subs
      .filter((s: any) => s.nextBillingDate && s.nextBillingDate <= cutoff)
      .sort((a: any, b: any) => a.nextBillingDate.getTime() - b.nextBillingDate.getTime());

    let totalDue = BigInt(0);
    for (const s of upcoming) {
      totalDue += s.amount;
    }

    return {
      totalDue,
      count: upcoming.length,
      billings: upcoming.map((s: any) => ({
        subscriptionId: s.id,
        planName: s.planName,
        amount: s.amount,
        currency: s.currency,
        dueDate: s.nextBillingDate,
      })),
    };
  }

  async getRenewalCountdown(userId: string) {
    const subs = await this.prisma.subscription.findMany({
      where: { userId, status: 'active' },
    });

    const now = Date.now();
    return subs
      .filter((s: any) => s.nextBillingDate)
      .map((s: any) => ({
        subscriptionId: s.id,
        planName: s.planName,
        amount: s.amount,
        currency: s.currency,
        nextBillingDate: s.nextBillingDate,
        daysUntilRenewal: Math.max(0, Math.ceil((s.nextBillingDate.getTime() - now) / (1000 * 60 * 60 * 24))),
      }))
      .sort((a: any, b: any) => a.daysUntilRenewal - b.daysUntilRenewal);
  }

  async getChurnAnalysis(userId: string) {
    const allSubs = await this.prisma.subscription.findMany({ where: { userId } });
    const cancelled = allSubs.filter((s: any) => s.status === 'cancelled');

    let totalLifetimeMs = 0;
    let totalSpendBeforeChurn = BigInt(0);
    const byPlan: Record<string, number> = {};

    for (const s of cancelled) {
      const cancelDate = (s as any).cancelledAt ?? s.createdAt;
      totalLifetimeMs += cancelDate.getTime() - s.createdAt.getTime();
      totalSpendBeforeChurn += s.amount;
      byPlan[s.planName] = (byPlan[s.planName] ?? 0) + 1;
    }

    const avgLifetimeDays = cancelled.length > 0
      ? Math.round(totalLifetimeMs / cancelled.length / (1000 * 60 * 60 * 24) * 10) / 10
      : 0;
    const churnRate = allSubs.length > 0
      ? Math.round(cancelled.length / allSubs.length * 10000) / 100
      : 0;

    const mostCancelledPlans = Object.entries(byPlan)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([plan, count]) => ({ plan, count }));

    return {
      totalSubscriptions: allSubs.length,
      cancelledCount: cancelled.length,
      churnRate,
      avgLifetimeDays,
      totalSpendBeforeChurn,
      mostCancelledPlans,
    };
  }

  async getCostOptimization(userId: string) {
    const allSubs = await this.prisma.subscription.findMany({ where: { userId } });
    const active = allSubs.filter((s: any) => s.status === 'active');
    const paused = allSubs.filter((s: any) => s.status === 'paused');
    const pastDue = allSubs.filter((s: any) => s.status === 'past_due');

    let monthlySpend = BigInt(0);
    const monthlyMultiplier: Record<string, number> = { daily: 30, weekly: 4, monthly: 1, yearly: 1 };
    const yearlyDivisor: Record<string, number> = { yearly: 12 };

    for (const s of active) {
      const interval = s.interval as string;
      const intervalCount = s.intervalCount ?? 1;
      const mult = monthlyMultiplier[interval] ?? 1;
      const div = yearlyDivisor[interval] ?? 1;
      monthlySpend += (s.amount * BigInt(mult)) / (BigInt(intervalCount) * BigInt(div));
    }

    let pausedMonthlySavings = BigInt(0);
    for (const s of paused) {
      const interval = s.interval as string;
      const intervalCount = s.intervalCount ?? 1;
      const mult = monthlyMultiplier[interval] ?? 1;
      const div = yearlyDivisor[interval] ?? 1;
      pausedMonthlySavings += (s.amount * BigInt(mult)) / (BigInt(intervalCount) * BigInt(div));
    }

    let pastDueAmount = BigInt(0);
    for (const s of pastDue) {
      pastDueAmount += s.amount;
    }

    const planCounts: Record<string, number> = {};
    for (const s of active) {
      planCounts[s.planName] = (planCounts[s.planName] ?? 0) + 1;
    }
    const duplicatePlans = Object.entries(planCounts)
      .filter(([, count]) => count > 1)
      .map(([plan, count]) => ({ plan, count }));

    const recommendations: string[] = [];
    if (paused.length > 0) recommendations.push(`${paused.length} paused subscription(s) could be cancelled to save costs`);
    if (pastDue.length > 0) recommendations.push(`${pastDue.length} past-due subscription(s) need attention`);
    if (duplicatePlans.length > 0) recommendations.push(`${duplicatePlans.length} duplicate plan(s) detected — consider consolidating`);

    return {
      activeSubscriptions: active.length,
      monthlySpend,
      pausedCount: paused.length,
      pausedMonthlySavings,
      pastDueCount: pastDue.length,
      pastDueAmount,
      duplicatePlans,
      recommendations,
    };
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
