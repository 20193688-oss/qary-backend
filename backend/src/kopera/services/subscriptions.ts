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

  async getUsageTimeline(userId: string) {
    const allSubs = await this.prisma.subscription.findMany({ where: { userId } });
    const now = Date.now();

    const byStatus: Record<string, number> = {};
    let totalTenureMs = 0;
    let longestTenureMs = 0;
    let longestSub: { id: string; planName: string; tenureDays: number } | null = null;
    const byPlan: Record<string, { count: number; totalTenureMs: number; active: number }> = {};

    for (const s of allSubs) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

      const endDate = (s as any).cancelledAt ?? now;
      const tenureMs = (typeof endDate === 'number' ? endDate : new Date(endDate).getTime()) - new Date(s.createdAt).getTime();
      totalTenureMs += tenureMs;

      if (!byPlan[s.planName]) byPlan[s.planName] = { count: 0, totalTenureMs: 0, active: 0 };
      byPlan[s.planName].count++;
      byPlan[s.planName].totalTenureMs += tenureMs;
      if (s.status === 'active') byPlan[s.planName].active++;

      if (tenureMs > longestTenureMs) {
        longestTenureMs = tenureMs;
        longestSub = {
          id: s.id,
          planName: s.planName,
          tenureDays: Math.round(tenureMs / (1000 * 60 * 60 * 24)),
        };
      }
    }

    const avgTenureDays = allSubs.length > 0
      ? Math.round(totalTenureMs / allSubs.length / (1000 * 60 * 60 * 24) * 10) / 10
      : 0;

    const planBreakdown = Object.entries(byPlan)
      .map(([plan, data]) => ({
        plan,
        totalSubscriptions: data.count,
        activeSubscriptions: data.active,
        avgTenureDays: Math.round(data.totalTenureMs / data.count / (1000 * 60 * 60 * 24) * 10) / 10,
      }))
      .sort((a, b) => b.totalSubscriptions - a.totalSubscriptions);

    const activeCount = byStatus['active'] ?? 0;
    const retentionRate = allSubs.length > 0
      ? Math.round((activeCount / allSubs.length) * 10000) / 100
      : 0;

    return {
      totalSubscriptions: allSubs.length,
      byStatus,
      avgTenureDays,
      longestSubscription: longestSub,
      retentionRate,
      planBreakdown,
    };
  }

  async getBillingHealth(userId: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId } });

    const active = subs.filter((s: any) => s.status === 'active');
    const pastDue = subs.filter((s: any) => s.status === 'past_due');
    const paused = subs.filter((s: any) => s.status === 'paused');

    let totalRetries = 0;
    let subsWithRetries = 0;
    const atRisk: Array<{ id: string; planName: string; retryCount: number; status: string }> = [];

    for (const s of subs) {
      const retries = (s as any).retryCount ?? 0;
      totalRetries += retries;
      if (retries > 0) subsWithRetries++;
      if (retries >= 2 || s.status === 'past_due') {
        atRisk.push({ id: s.id, planName: s.planName, retryCount: retries, status: s.status });
      }
    }

    const avgRetries = subs.length > 0
      ? Math.round(totalRetries / subs.length * 100) / 100
      : 0;

    const failureRate = subs.length > 0
      ? Math.round((pastDue.length / subs.length) * 10000) / 100
      : 0;

    let healthScore = 100;
    healthScore -= pastDue.length * 20;
    healthScore -= subsWithRetries * 5;
    healthScore = Math.max(0, healthScore);

    let rating: string;
    if (healthScore >= 90) rating = 'excellent';
    else if (healthScore >= 70) rating = 'good';
    else if (healthScore >= 50) rating = 'fair';
    else rating = 'poor';

    return {
      totalSubscriptions: subs.length,
      activeCount: active.length,
      pastDueCount: pastDue.length,
      pausedCount: paused.length,
      failureRate,
      avgRetries,
      atRiskCount: atRisk.length,
      atRiskSubscriptions: atRisk,
      healthScore,
      rating,
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

  async getSpendingTrend(userId: string) {
    const subs = await this.prisma.subscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (subs.length === 0) {
      return {
        totalSubscriptions: 0,
        activeSubscriptions: 0,
        currentMonthlyCost: '0',
        monthlyTrend: [],
        projectedNextMonth: '0',
        monthOverMonthChange: 0,
      };
    }

    const active = subs.filter((s: any) => s.status === 'active');

    const currentMonthlyCost = active.reduce((sum: bigint, s: any) => {
      const interval = s.interval;
      const count = s.intervalCount ?? 1;
      const monthly = interval === 'daily'
        ? s.amount * BigInt(30) / BigInt(count)
        : interval === 'weekly'
          ? s.amount * BigInt(4) / BigInt(count)
          : interval === 'yearly'
            ? s.amount / BigInt(12 * count)
            : s.amount / BigInt(count);
      return sum + monthly;
    }, BigInt(0));

    const now = new Date();
    const monthlyTrend: any[] = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);

      let monthlyCost = BigInt(0);
      for (const s of subs) {
        const created = new Date(s.createdAt);
        const cancelledAt = (s as any).cancelledAt ? new Date((s as any).cancelledAt) : null;
        if (created <= monthEnd && (!cancelledAt || cancelledAt >= monthStart)) {
          const interval = (s as any).interval;
          const count = (s as any).intervalCount ?? 1;
          const monthly = interval === 'daily'
            ? s.amount * BigInt(30) / BigInt(count)
            : interval === 'weekly'
              ? s.amount * BigInt(4) / BigInt(count)
              : interval === 'yearly'
                ? s.amount / BigInt(12 * count)
                : s.amount / BigInt(count);
          monthlyCost += monthly;
        }
      }

      monthlyTrend.push({
        month: monthStart.toISOString().slice(0, 7),
        cost: monthlyCost.toString(),
        subscriptionCount: subs.filter((s: any) => {
          const created = new Date(s.createdAt);
          const cancelledAt = (s as any).cancelledAt ? new Date((s as any).cancelledAt) : null;
          return created <= monthEnd && (!cancelledAt || cancelledAt >= monthStart);
        }).length,
      });
    }

    const recentCosts = monthlyTrend.slice(-2);
    let monthOverMonthChange = 0;
    if (recentCosts.length === 2) {
      const prev = Number(BigInt(recentCosts[0].cost));
      const curr = Number(BigInt(recentCosts[1].cost));
      monthOverMonthChange = prev > 0
        ? Math.round(((curr - prev) / prev) * 10000) / 100
        : 0;
    }

    return {
      totalSubscriptions: subs.length,
      activeSubscriptions: active.length,
      currentMonthlyCost: currentMonthlyCost.toString(),
      monthlyTrend,
      projectedNextMonth: currentMonthlyCost.toString(),
      monthOverMonthChange,
    };
  }

  async getCancellationRisk(userId: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId } });
    const active = subs.filter((s: any) => s.status === 'active');

    if (active.length === 0) {
      return {
        totalActive: 0,
        atRisk: [] as Array<{ subscriptionId: string; planName: string; riskLevel: string; riskScore: number; reasons: string[] }>,
        safeCount: 0,
        overallRiskScore: 0,
      };
    }

    const cancelled = subs.filter((s: any) => s.status === 'cancelled');
    const cancelRate = subs.length > 0 ? cancelled.length / subs.length : 0;

    const atRisk: Array<{
      subscriptionId: string; planName: string; riskLevel: string;
      riskScore: number; reasons: string[];
    }> = [];
    let safeCount = 0;

    for (const s of active) {
      let riskScore = 0;
      const reasons: string[] = [];

      const amount = Number(s.amount);
      const avgAmount = active.reduce((sum, a) => sum + Number(a.amount), 0) / active.length;
      if (amount > avgAmount * 2) {
        riskScore += 25;
        reasons.push('Cost significantly above average');
      }

      const ageMs = Date.now() - new Date(s.createdAt).getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      if (ageDays < 30) {
        riskScore += 20;
        reasons.push('New subscription (< 30 days)');
      }

      if (cancelRate > 0.3) {
        riskScore += 15;
        reasons.push('High overall cancellation rate');
      }

      const periodEnd = (s as any).currentPeriodEnd;
      if (periodEnd) {
        const daysUntilRenewal = Math.ceil((new Date(periodEnd).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysUntilRenewal <= 7 && daysUntilRenewal > 0) {
          riskScore += 10;
          reasons.push('Renewal approaching within 7 days');
        }
      }

      if ((s as any).interval === 'monthly') {
        riskScore += 5;
        reasons.push('Monthly billing (higher churn than annual)');
      }

      riskScore = Math.min(100, riskScore);

      if (riskScore >= 30) {
        const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 40 ? 'moderate' : 'low';
        atRisk.push({
          subscriptionId: s.id,
          planName: (s as any).planName ?? 'unknown',
          riskLevel,
          riskScore,
          reasons,
        });
      } else {
        safeCount++;
      }
    }

    atRisk.sort((a, b) => b.riskScore - a.riskScore);

    const overallRiskScore = active.length > 0
      ? Math.round((atRisk.reduce((s, r) => s + r.riskScore, 0) / active.length) * 100) / 100
      : 0;

    return {
      totalActive: active.length,
      atRisk,
      safeCount,
      overallRiskScore,
    };
  }

  async getPlanPopularity(userId: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId } });

    if (subs.length === 0) {
      return {
        totalSubscriptions: 0,
        activePlans: 0,
        byPlan: [],
        mostUsedPlan: null,
        avgDurationDays: 0,
        planSwitchCount: 0,
      };
    }

    const planMap = new Map<string, { count: number; active: number; totalSpent: number; durations: number[] }>();
    const active = subs.filter((s) => s.status === 'active' || s.status === 'trialing');

    for (const s of subs) {
      const plan = s.planId ?? s.planName ?? 'unknown';
      const entry = planMap.get(plan) ?? { count: 0, active: 0, totalSpent: 0, durations: [] };
      entry.count++;
      if (s.status === 'active' || s.status === 'trialing') entry.active++;
      entry.totalSpent += Number(s.amount ?? 0);
      const start = new Date(s.currentPeriodStart ?? s.createdAt).getTime();
      const end = s.cancelledAt ? new Date(s.cancelledAt).getTime() : Date.now();
      entry.durations.push(Math.ceil((end - start) / 86400000));
      planMap.set(plan, entry);
    }

    const byPlan = Array.from(planMap.entries())
      .map(([plan, data]) => ({
        plan,
        count: data.count,
        active: data.active,
        totalSpent: data.totalSpent.toString(),
        avgDurationDays: data.durations.length > 0
          ? Math.round(data.durations.reduce((s, v) => s + v, 0) / data.durations.length)
          : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const allDurations = Array.from(planMap.values()).flatMap((d) => d.durations);
    const avgDurationDays = allDurations.length > 0
      ? Math.round(allDurations.reduce((s, v) => s + v, 0) / allDurations.length)
      : 0;

    const cancelled = subs.filter((s) => s.status === 'cancelled' || s.status === 'expired');
    const planSwitchCount = Math.max(0, cancelled.length);

    return {
      totalSubscriptions: subs.length,
      activePlans: active.length,
      byPlan,
      mostUsedPlan: byPlan[0]?.plan ?? null,
      avgDurationDays,
      planSwitchCount,
    };
  }

  async getSubscriptionLifetimeValue(userId: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId } });
    if (subs.length === 0) {
      return {
        totalSubscriptions: 0,
        totalSpent: '0',
        avgSubscriptionValue: '0',
        avgDurationMonths: 0,
        estimatedLifetimeValue: '0',
        churnRate: 0,
      };
    }

    let totalSpent = BigInt(0);
    const durations: number[] = [];
    let cancelledCount = 0;

    for (const s of subs) {
      const amount = BigInt((s as any).amount || 0);
      const start = new Date(s.createdAt).getTime();
      const end = (s as any).cancelledAt
        ? new Date((s as any).cancelledAt).getTime()
        : Date.now();
      const months = Math.max(1, Math.round((end - start) / (30 * 86400000)));
      durations.push(months);
      totalSpent += amount * BigInt(months);
      if ((s as any).status === 'cancelled') cancelledCount++;
    }

    const avgDuration = durations.length > 0
      ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1))
      : 0;

    const avgValue = subs.length > 0
      ? totalSpent / BigInt(subs.length)
      : BigInt(0);

    const churnRate = subs.length > 0
      ? Number((cancelledCount / subs.length).toFixed(4))
      : 0;

    const avgMonthlySpend = durations.length > 0
      ? totalSpent / BigInt(Math.round(durations.reduce((a, b) => a + b, 0)))
      : BigInt(0);

    const estimatedLifetimeValue = churnRate > 0
      ? avgMonthlySpend * BigInt(Math.round(1 / churnRate))
      : totalSpent;

    return {
      totalSubscriptions: subs.length,
      totalSpent: totalSpent.toString(),
      avgSubscriptionValue: avgValue.toString(),
      avgDurationMonths: avgDuration,
      estimatedLifetimeValue: estimatedLifetimeValue.toString(),
      churnRate,
    };
  }

  async getSubscriptionOverlapAnalysis(userId: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId } });

    if (subs.length === 0) {
      return {
        totalSubscriptions: 0,
        activeCount: 0,
        overlapGroups: [] as { plan: string; count: number; totalCost: string }[],
        potentialSavings: '0',
        recommendations: [] as string[],
      };
    }

    const active = subs.filter(s => ((s as any).status || '').toLowerCase() === 'active');
    const planMap = new Map<string, { count: number; totalCost: bigint; ids: string[] }>();

    for (const s of active) {
      const plan = ((s as any).planName || (s as any).plan || 'unknown').toLowerCase();
      const cost = (s as any).amount ?? BigInt(0);
      const existing = planMap.get(plan) || { count: 0, totalCost: BigInt(0), ids: [] };
      existing.count++;
      existing.totalCost += BigInt(cost.toString());
      existing.ids.push(s.id);
      planMap.set(plan, existing);
    }

    const overlapGroups = Array.from(planMap.entries())
      .filter(([, data]) => data.count > 1)
      .map(([plan, data]) => ({
        plan,
        count: data.count,
        totalCost: data.totalCost.toString(),
      }))
      .sort((a, b) => b.count - a.count);

    let potentialSavings = BigInt(0);
    for (const group of overlapGroups) {
      const planData = planMap.get(group.plan)!;
      const avgCost = planData.totalCost / BigInt(planData.count);
      potentialSavings += planData.totalCost - avgCost;
    }

    const recommendations: string[] = [];
    if (overlapGroups.length > 0) recommendations.push(`${overlapGroups.length} plan(s) have duplicate subscriptions — consider consolidating`);
    if (active.length > 10) recommendations.push('High number of active subscriptions — review for unused services');
    const cancelled = subs.filter(s => ((s as any).status || '').toLowerCase() === 'cancelled');
    if (cancelled.length > active.length) recommendations.push('More cancelled than active subscriptions — investigate churn drivers');

    return {
      totalSubscriptions: subs.length,
      activeCount: active.length,
      overlapGroups,
      potentialSavings: potentialSavings.toString(),
      recommendations,
    };
  }

  async getSubscriptionCostTrendForecast(userId: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId } });
    if (subs.length === 0) {
      return {
        totalActive: 0,
        currentMonthlyCost: '0',
        projectedMonthlyCost: '0',
        costChangePercent: 0,
        trendDirection: 'stable' as const,
        recommendations: [] as string[],
      };
    }

    const active = subs.filter(s => ((s as any).status || '').toLowerCase() === 'active');
    let currentCost = BigInt(0);
    let projectedCost = BigInt(0);

    for (const s of active) {
      const amount = BigInt((s as any).amount ?? 0);
      const interval = ((s as any).billingInterval || (s as any).interval || 'monthly').toLowerCase();
      const monthlyCost = interval === 'yearly' || interval === 'annual'
        ? amount / BigInt(12)
        : interval === 'weekly' ? amount * BigInt(4)
        : amount;
      currentCost += monthlyCost;
    }

    const recentlyCancelled = subs.filter(s => {
      const status = ((s as any).status || '').toLowerCase();
      const cancelledAt = (s as any).cancelledAt;
      if (status !== 'cancelled' || !cancelledAt) return false;
      return Date.now() - new Date(cancelledAt).getTime() < 30 * 86400000;
    });

    projectedCost = currentCost;
    for (const s of recentlyCancelled) {
      const amount = BigInt((s as any).amount ?? 0);
      projectedCost -= amount;
    }
    if (projectedCost < BigInt(0)) projectedCost = BigInt(0);

    const changePercent = Number(currentCost) > 0
      ? Math.round((Number(projectedCost) - Number(currentCost)) / Number(currentCost) * 10000) / 100
      : 0;

    const trendDirection = changePercent > 5 ? 'increasing'
      : changePercent < -5 ? 'decreasing' : 'stable';

    const recommendations: string[] = [];
    if (trendDirection === 'increasing') recommendations.push('Subscription costs are trending upward — review new additions');
    if (active.length > 5) recommendations.push('Many active subscriptions — check for redundancies');
    if (recentlyCancelled.length > 0) recommendations.push(`${recentlyCancelled.length} recent cancellation(s) will reduce projected costs`);

    return {
      totalActive: active.length,
      currentMonthlyCost: currentCost.toString(),
      projectedMonthlyCost: projectedCost.toString(),
      costChangePercent: changePercent,
      trendDirection,
      recommendations,
    };
  }
}
