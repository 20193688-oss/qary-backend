import type { PrismaClient } from '@prisma/client';

export class TransactionLimitService {
  constructor(private prisma: PrismaClient) {}

  async setLimit(params: {
    userId: string;
    currency: string;
    limitType: string;
    maxAmount: bigint;
  }) {
    const limitType = params.limitType.toLowerCase();
    if (limitType !== 'daily' && limitType !== 'monthly') {
      throw new Error('invalid_limit_type');
    }

    return this.prisma.transactionLimit.upsert({
      where: {
        userId_currency_limitType: {
          userId: params.userId,
          currency: params.currency.toUpperCase(),
          limitType,
        },
      },
      update: { maxAmount: params.maxAmount },
      create: {
        userId: params.userId,
        currency: params.currency.toUpperCase(),
        limitType,
        maxAmount: params.maxAmount,
        currentUsage: BigInt(0),
        periodStart: this.periodStart(limitType),
      },
    });
  }

  async getLimits(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { userId },
    });
    return limits.map((l) => this.refreshIfNeeded(l));
  }

  async getLimit(userId: string, currency: string, limitType: string) {
    const limit = await this.prisma.transactionLimit.findFirst({
      where: { userId, currency: currency.toUpperCase(), limitType: limitType.toLowerCase() },
    });
    if (!limit) return null;
    return this.refreshIfNeeded(limit);
  }

  async checkAndIncrement(userId: string, currency: string, amount: bigint): Promise<{ allowed: boolean; reason?: string }> {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { userId, currency: currency.toUpperCase() },
    });

    for (const raw of limits) {
      const limit = this.refreshIfNeeded(raw);
      if (limit.currentUsage + amount > limit.maxAmount) {
        return { allowed: false, reason: `${limit.limitType}_limit_exceeded` };
      }
    }

    for (const limit of limits) {
      const refreshed = this.refreshIfNeeded(limit);
      await this.prisma.transactionLimit.update({
        where: { id: refreshed.id },
        data: {
          currentUsage: refreshed.currentUsage + amount,
          periodStart: refreshed.periodStart,
        },
      });
    }

    return { allowed: true };
  }

  async checkAvailable(userId: string, currency: string, amount: bigint): Promise<{ allowed: boolean; reason?: string }> {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { userId, currency: currency.toUpperCase() },
    });

    for (const raw of limits) {
      const limit = this.refreshIfNeeded(raw);
      if (limit.currentUsage + amount > limit.maxAmount) {
        return { allowed: false, reason: `${limit.limitType}_limit_exceeded` };
      }
    }

    return { allowed: true };
  }

  async getUsageSummary(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    const refreshed = limits.map((l) => this.refreshIfNeeded(l));

    const byType: Record<string, number> = {};
    let totalMaxAmount = BigInt(0);
    let totalCurrentUsage = BigInt(0);

    for (const l of refreshed) {
      byType[l.limitType] = (byType[l.limitType] ?? 0) + 1;
      totalMaxAmount += l.maxAmount;
      totalCurrentUsage += l.currentUsage;
    }

    return {
      totalLimits: refreshed.length,
      byType,
      totalMaxAmount,
      totalCurrentUsage,
      utilizationPercent: totalMaxAmount > BigInt(0)
        ? Number((totalCurrentUsage * BigInt(10000)) / totalMaxAmount) / 100
        : 0,
    };
  }

  async getUtilizationReport(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    const refreshed = limits.map((l) => this.refreshIfNeeded(l));

    const details = refreshed.map((l: any) => {
      const utilization = l.maxAmount > BigInt(0)
        ? Number((l.currentUsage * BigInt(10000)) / l.maxAmount) / 100
        : 0;
      const headroom = l.maxAmount - l.currentUsage;
      const nearLimit = utilization >= 80;

      return {
        id: l.id,
        currency: l.currency,
        limitType: l.limitType,
        maxAmount: l.maxAmount,
        currentUsage: l.currentUsage,
        headroom: headroom > BigInt(0) ? headroom : BigInt(0),
        utilization,
        nearLimit,
      };
    });

    const nearLimitCount = details.filter(d => d.nearLimit).length;

    return {
      totalLimits: details.length,
      nearLimitCount,
      details,
    };
  }

  async getLimitHealthCheck(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    const refreshed = limits.map((l: any) => this.refreshIfNeeded(l));

    const recommendations: string[] = [];
    const details = refreshed.map((l: any) => {
      const utilization = l.maxAmount > BigInt(0)
        ? Number((l.currentUsage * BigInt(10000)) / l.maxAmount) / 100
        : 0;
      const headroom = l.maxAmount - l.currentUsage;

      let assessment: string;
      if (utilization >= 95) {
        assessment = 'critical';
        recommendations.push(`${l.currency} ${l.limitType} limit nearly exhausted (${utilization}% used)`);
      } else if (utilization >= 80) {
        assessment = 'warning';
        recommendations.push(`${l.currency} ${l.limitType} limit approaching threshold (${utilization}% used)`);
      } else if (utilization <= 10 && l.maxAmount > BigInt(0)) {
        assessment = 'underutilized';
        recommendations.push(`${l.currency} ${l.limitType} limit may be too high (only ${utilization}% used)`);
      } else {
        assessment = 'healthy';
      }

      return {
        id: l.id,
        currency: l.currency,
        limitType: l.limitType,
        maxAmount: l.maxAmount,
        currentUsage: l.currentUsage,
        headroom: headroom > BigInt(0) ? headroom : BigInt(0),
        utilization,
        assessment,
      };
    });

    const criticalCount = details.filter((d: any) => d.assessment === 'critical').length;
    const warningCount = details.filter((d: any) => d.assessment === 'warning').length;
    const healthyCount = details.filter((d: any) => d.assessment === 'healthy').length;
    const underutilizedCount = details.filter((d: any) => d.assessment === 'underutilized').length;

    const overallHealth = criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : 'healthy';

    return {
      totalLimits: details.length,
      overallHealth,
      criticalCount,
      warningCount,
      healthyCount,
      underutilizedCount,
      recommendations,
      details,
    };
  }

  async getSpendingVelocity(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({
      where: { userId },
    });

    if (limits.length === 0) {
      return {
        totalLimits: 0,
        velocities: [] as Array<{
          currency: string;
          limitType: string;
          maxAmount: string;
          currentUsage: string;
          utilizationPercent: number;
          remainingAmount: string;
          burnRatePerHour: string;
          estimatedExhaustionHours: number | null;
        }>,
        fastestBurning: null as { currency: string; limitType: string; burnRatePerHour: string } | null,
        avgUtilization: 0,
      };
    }

    const now = new Date();
    const velocities: Array<{
      currency: string;
      limitType: string;
      maxAmount: string;
      currentUsage: string;
      utilizationPercent: number;
      remainingAmount: string;
      burnRatePerHour: string;
      estimatedExhaustionHours: number | null;
    }> = [];

    let totalUtil = 0;
    let fastestBurnRate = BigInt(0);
    let fastestBurning: { currency: string; limitType: string; burnRatePerHour: string } | null = null;

    for (const raw of limits) {
      const limit = this.refreshIfNeeded(raw);
      const maxAmt = limit.maxAmount as bigint;
      const usage = limit.currentUsage as bigint;
      const remaining = maxAmt > usage ? maxAmt - usage : BigInt(0);
      const utilPercent = maxAmt > BigInt(0)
        ? Math.round(Number(usage * BigInt(10000) / maxAmt)) / 100
        : 0;
      totalUtil += utilPercent;

      const periodStartTime = (limit.periodStart as Date).getTime();
      const elapsedHours = Math.max(1, (now.getTime() - periodStartTime) / (1000 * 60 * 60));
      const burnRatePerHour = usage > BigInt(0)
        ? BigInt(Math.round(Number(usage) / elapsedHours))
        : BigInt(0);

      const estimatedExhaustionHours = burnRatePerHour > BigInt(0)
        ? Math.round(Number(remaining) / Number(burnRatePerHour) * 100) / 100
        : null;

      velocities.push({
        currency: limit.currency,
        limitType: limit.limitType,
        maxAmount: maxAmt.toString(),
        currentUsage: usage.toString(),
        utilizationPercent: utilPercent,
        remainingAmount: remaining.toString(),
        burnRatePerHour: burnRatePerHour.toString(),
        estimatedExhaustionHours,
      });

      if (burnRatePerHour > fastestBurnRate) {
        fastestBurnRate = burnRatePerHour;
        fastestBurning = {
          currency: limit.currency,
          limitType: limit.limitType,
          burnRatePerHour: burnRatePerHour.toString(),
        };
      }
    }

    return {
      totalLimits: limits.length,
      velocities,
      fastestBurning,
      avgUtilization: Math.round(totalUtil / limits.length * 100) / 100,
    };
  }

  async getCurrencyBreakdown(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });

    if (limits.length === 0) {
      return {
        totalLimits: 0,
        distinctCurrencies: 0,
        byCurrency: [],
      };
    }

    const currMap = new Map<string, { maxTotal: bigint; usageTotal: bigint; daily: number; monthly: number }>();
    for (const l of limits) {
      const entry = currMap.get(l.currency) ?? { maxTotal: BigInt(0), usageTotal: BigInt(0), daily: 0, monthly: 0 };
      entry.maxTotal += l.maxAmount;
      entry.usageTotal += l.currentUsage;
      if (l.limitType === 'daily') entry.daily++;
      else entry.monthly++;
      currMap.set(l.currency, entry);
    }

    const byCurrency = Array.from(currMap.entries())
      .map(([currency, data]) => ({
        currency,
        totalMaxAmount: data.maxTotal.toString(),
        totalCurrentUsage: data.usageTotal.toString(),
        utilization: Number(data.maxTotal) > 0
          ? Math.round(Number(data.usageTotal) * 10000 / Number(data.maxTotal)) / 100
          : 0,
        dailyLimits: data.daily,
        monthlyLimits: data.monthly,
      }))
      .sort((a, b) => Number(BigInt(b.totalMaxAmount) - BigInt(a.totalMaxAmount)));

    return {
      totalLimits: limits.length,
      distinctCurrencies: currMap.size,
      byCurrency,
    };
  }

  async getLimitExhaustionForecast(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    if (limits.length === 0) {
      return {
        totalLimits: 0,
        forecasts: [],
        criticalCount: 0,
        warningCount: 0,
        safeCount: 0,
        overallRisk: 'none' as const,
      };
    }

    const now = Date.now();
    const forecasts: {
      currency: string;
      limitType: string;
      maxAmount: string;
      currentUsage: string;
      utilizationPercent: number;
      projectedExhaustionHours: number | null;
      riskLevel: string;
    }[] = [];

    let criticalCount = 0;
    let warningCount = 0;
    let safeCount = 0;

    for (const limit of limits) {
      const l = limit as any;
      const max = Number(l.maxAmount);
      const usage = Number(l.currentUsage);
      const utilization = max > 0 ? Math.round((usage / max) * 10000) / 100 : 0;

      const periodStart = new Date(l.periodStart || l.createdAt).getTime();
      const elapsedHours = Math.max(1, (now - periodStart) / 3600000);
      const usageRate = usage / elapsedHours;

      let projectedExhaustionHours: number | null = null;
      if (usageRate > 0 && usage < max) {
        const remaining = max - usage;
        projectedExhaustionHours = Math.round((remaining / usageRate) * 10) / 10;
      } else if (usage >= max) {
        projectedExhaustionHours = 0;
      }

      let riskLevel: string;
      if (utilization >= 95 || projectedExhaustionHours === 0) {
        riskLevel = 'critical';
        criticalCount++;
      } else if (utilization >= 75 || (projectedExhaustionHours !== null && projectedExhaustionHours < 24)) {
        riskLevel = 'warning';
        warningCount++;
      } else {
        riskLevel = 'safe';
        safeCount++;
      }

      forecasts.push({
        currency: l.currency,
        limitType: l.limitType,
        maxAmount: l.maxAmount.toString(),
        currentUsage: l.currentUsage.toString(),
        utilizationPercent: utilization,
        projectedExhaustionHours,
        riskLevel,
      });
    }

    forecasts.sort((a, b) => {
      const order: Record<string, number> = { critical: 0, warning: 1, safe: 2 };
      return (order[a.riskLevel] ?? 3) - (order[b.riskLevel] ?? 3);
    });

    const overallRisk = criticalCount > 0 ? 'critical'
      : warningCount > 0 ? 'warning'
      : 'safe';

    return {
      totalLimits: limits.length,
      forecasts,
      criticalCount,
      warningCount,
      safeCount,
      overallRisk,
    };
  }

  async removeLimit(userId: string, currency: string, limitType: string) {
    const limit = await this.prisma.transactionLimit.findFirst({
      where: { userId, currency: currency.toUpperCase(), limitType: limitType.toLowerCase() },
    });
    if (!limit) throw new Error('limit_not_found');
    if (limit.userId !== userId) throw new Error('forbidden');

    return this.prisma.transactionLimit.delete({ where: { id: limit.id } });
  }

  private periodStart(limitType: string): Date {
    const now = new Date();
    if (limitType === 'daily') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  async getLimitComplianceReport(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });

    if (limits.length === 0) {
      return {
        totalLimits: 0,
        compliantCount: 0,
        nearLimitCount: 0,
        exceededCount: 0,
        complianceRate: 100,
        byLimitType: [],
        recommendations: [],
      };
    }

    let compliantCount = 0;
    let nearLimitCount = 0;
    let exceededCount = 0;

    const typeMap = new Map<string, { total: number; compliant: number; nearLimit: number; exceeded: number }>();

    for (const limit of limits) {
      const refreshed = this.refreshIfNeeded(limit);
      const usage = Number(refreshed.currentUsage);
      const max = Number(refreshed.maxAmount);
      const utilization = max > 0 ? (usage / max) * 100 : 0;

      const entry = typeMap.get(limit.limitType) ?? { total: 0, compliant: 0, nearLimit: 0, exceeded: 0 };
      entry.total++;

      if (utilization > 100) {
        exceededCount++;
        entry.exceeded++;
      } else if (utilization >= 80) {
        nearLimitCount++;
        entry.nearLimit++;
      } else {
        compliantCount++;
        entry.compliant++;
      }
      typeMap.set(limit.limitType, entry);
    }

    const byLimitType = Array.from(typeMap.entries()).map(([type, data]) => ({
      limitType: type,
      total: data.total,
      compliant: data.compliant,
      nearLimit: data.nearLimit,
      exceeded: data.exceeded,
    }));

    const complianceRate = limits.length > 0
      ? Math.round((compliantCount / limits.length) * 100)
      : 100;

    const recommendations: string[] = [];
    if (exceededCount > 0) {
      recommendations.push(`${exceededCount} limit(s) exceeded — review spending patterns`);
    }
    if (nearLimitCount > 0) {
      recommendations.push(`${nearLimitCount} limit(s) near capacity — consider increasing limits`);
    }

    return {
      totalLimits: limits.length,
      compliantCount,
      nearLimitCount,
      exceededCount,
      complianceRate,
      byLimitType,
      recommendations,
    };
  }

  async getLimitBreachHistory(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    if (limits.length === 0) {
      return {
        totalLimits: 0,
        breachedCount: 0,
        nearBreachCount: 0,
        safeCount: 0,
        overallUtilization: 0,
        limits: [],
      };
    }

    let breachedCount = 0;
    let nearBreachCount = 0;
    let safeCount = 0;
    let totalUtilization = 0;

    const limitDetails: { currency: string; limitType: string; maxAmount: string; currentUsage: string; utilization: number; status: string }[] = [];

    for (const l of limits) {
      const maxAmount = BigInt((l as any).maxAmount || 1);
      const currentUsage = BigInt((l as any).currentUsage || 0);
      const utilization = maxAmount > 0
        ? Number((currentUsage * BigInt(10000) / maxAmount)) / 100
        : 0;
      totalUtilization += utilization;

      let status: string;
      if (utilization >= 100) {
        status = 'breached';
        breachedCount++;
      } else if (utilization >= 80) {
        status = 'near_breach';
        nearBreachCount++;
      } else {
        status = 'safe';
        safeCount++;
      }

      limitDetails.push({
        currency: (l as any).currency || 'USD',
        limitType: (l as any).limitType || 'daily',
        maxAmount: maxAmount.toString(),
        currentUsage: currentUsage.toString(),
        utilization: Number(utilization.toFixed(2)),
        status,
      });
    }

    const overallUtilization = limits.length > 0
      ? Number((totalUtilization / limits.length).toFixed(2))
      : 0;

    return {
      totalLimits: limits.length,
      breachedCount,
      nearBreachCount,
      safeCount,
      overallUtilization,
      limits: limitDetails,
    };
  }

  async getLimitAdjustmentRecommendation(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });

    if (limits.length === 0) {
      return {
        totalLimits: 0,
        adjustments: [] as { currency: string; limitType: string; currentLimit: string; suggestedLimit: string; reason: string }[],
        overallUtilization: 0,
        recommendations: [] as string[],
      };
    }

    const adjustments: { currency: string; limitType: string; currentLimit: string; suggestedLimit: string; reason: string }[] = [];
    let totalUtil = 0;

    for (const l of limits) {
      const refreshed = this.refreshIfNeeded(l);
      const maxAmount = BigInt((refreshed as any).maxAmount ?? 0);
      const currentUsage = BigInt((refreshed as any).currentUsage ?? 0);
      const utilization = maxAmount > BigInt(0)
        ? Number(currentUsage * BigInt(100) / maxAmount)
        : 0;
      totalUtil += utilization;

      const currency = (refreshed as any).currency || 'USD';
      const limitType = (refreshed as any).limitType || 'daily';

      if (utilization > 90) {
        const suggested = maxAmount * BigInt(150) / BigInt(100);
        adjustments.push({
          currency,
          limitType,
          currentLimit: maxAmount.toString(),
          suggestedLimit: suggested.toString(),
          reason: 'Usage consistently near limit — increase recommended',
        });
      } else if (utilization < 10 && maxAmount > BigInt(0)) {
        const suggested = maxAmount * BigInt(50) / BigInt(100);
        adjustments.push({
          currency,
          limitType,
          currentLimit: maxAmount.toString(),
          suggestedLimit: suggested.toString(),
          reason: 'Very low usage — consider reducing limit for tighter control',
        });
      }
    }

    const overallUtilization = limits.length > 0
      ? Number((totalUtil / limits.length).toFixed(2))
      : 0;

    const recommendations: string[] = [];
    const highUtil = adjustments.filter(a => a.reason.includes('increase'));
    const lowUtil = adjustments.filter(a => a.reason.includes('reducing'));
    if (highUtil.length > 0) recommendations.push(`${highUtil.length} limit(s) near exhaustion — consider increasing`);
    if (lowUtil.length > 0) recommendations.push(`${lowUtil.length} limit(s) significantly underused — tighten for better control`);
    if (adjustments.length === 0) recommendations.push('All limits are within healthy utilization range');

    return {
      totalLimits: limits.length,
      adjustments,
      overallUtilization,
      recommendations,
    };
  }

  async getLimitEfficiencyIndex(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });
    if (limits.length === 0) {
      return {
        totalLimits: 0,
        efficiencyIndex: 0,
        efficiencyLevel: 'no_data',
        optimalCount: 0,
        wastefulCount: 0,
        tightCount: 0,
        recommendations: [],
      };
    }

    let optimalCount = 0;
    let wastefulCount = 0;
    let tightCount = 0;
    let totalEfficiency = 0;

    for (const l of limits) {
      const refreshed = this.refreshIfNeeded(l);
      const maxAmount = BigInt((refreshed as any).maxAmount ?? 0);
      const currentUsage = BigInt((refreshed as any).currentUsage ?? 0);
      const utilization = maxAmount > BigInt(0)
        ? Number(currentUsage * BigInt(100) / maxAmount)
        : 0;

      if (utilization >= 30 && utilization <= 80) { optimalCount++; totalEfficiency += 100; }
      else if (utilization < 10) { wastefulCount++; totalEfficiency += 20; }
      else if (utilization > 90) { tightCount++; totalEfficiency += 40; }
      else { totalEfficiency += 60; }
    }

    const efficiencyIndex = Math.round(totalEfficiency / limits.length);
    const efficiencyLevel = efficiencyIndex >= 70 ? 'optimal'
      : efficiencyIndex >= 40 ? 'suboptimal' : 'poor';

    const recommendations: string[] = [];
    if (wastefulCount > 0) recommendations.push(`${wastefulCount} limit(s) barely used — tighten or remove`);
    if (tightCount > 0) recommendations.push(`${tightCount} limit(s) nearly maxed out — increase to avoid rejections`);
    if (efficiencyLevel === 'optimal') recommendations.push('Limits are well-calibrated to usage patterns');

    return {
      totalLimits: limits.length,
      efficiencyIndex,
      efficiencyLevel,
      optimalCount,
      wastefulCount,
      tightCount,
      recommendations,
    };
  }

  async getLimitCapacityPlanning(userId: string) {
    const limits = await this.prisma.transactionLimit.findMany({ where: { userId } });

    if (limits.length === 0) {
      return {
        totalLimits: 0,
        capacityLevel: 'no_data' as const,
        capacityScore: 0,
        planning: [],
        recommendations: [],
      };
    }

    const planning: { currency: string; limitType: string; maxAmount: string; currentUsage: string; utilizationPercent: number; suggestedAction: string; priority: string }[] = [];

    for (const limit of limits) {
      const refreshed = this.refreshIfNeeded(limit);
      const usage = Number(refreshed.currentUsage);
      const max = Number(refreshed.maxAmount);
      const utilization = max > 0 ? Math.round((usage / max) * 100) : 0;

      let suggestedAction = 'maintain';
      let priority = 'low';
      if (utilization >= 95) { suggestedAction = 'increase_urgently'; priority = 'critical'; }
      else if (utilization >= 80) { suggestedAction = 'increase'; priority = 'high'; }
      else if (utilization <= 10) { suggestedAction = 'decrease_or_remove'; priority = 'medium'; }
      else if (utilization <= 30) { suggestedAction = 'decrease'; priority = 'low'; }

      planning.push({
        currency: limit.currency,
        limitType: limit.limitType,
        maxAmount: BigInt(refreshed.maxAmount).toString(),
        currentUsage: BigInt(refreshed.currentUsage).toString(),
        utilizationPercent: utilization,
        suggestedAction,
        priority,
      });
    }

    const criticalCount = planning.filter(p => p.priority === 'critical').length;
    const highCount = planning.filter(p => p.priority === 'high').length;

    let capacityScore = 50;
    if (criticalCount > 0) capacityScore += Math.min(40, criticalCount * 20);
    if (highCount > 0) capacityScore += Math.min(20, highCount * 10);
    capacityScore = Math.min(100, capacityScore);

    const capacityLevel = capacityScore >= 70 ? 'needs_expansion'
      : capacityScore >= 40 ? 'adequate' : 'well_provisioned';

    const recommendations: string[] = [];
    if (criticalCount > 0) recommendations.push(`${criticalCount} limit(s) near capacity — expand immediately`);
    if (highCount > 0) recommendations.push(`${highCount} limit(s) approaching capacity — plan increase`);
    const decreaseCount = planning.filter(p => p.suggestedAction.startsWith('decrease')).length;
    if (decreaseCount > 0) recommendations.push(`${decreaseCount} limit(s) underutilized — consider reducing`);
    if (capacityLevel === 'well_provisioned') recommendations.push('All limits well-provisioned for current usage');

    return {
      totalLimits: limits.length,
      capacityLevel,
      capacityScore,
      criticalCount,
      highCount,
      planning,
      recommendations,
    };
  }

  private refreshIfNeeded(limit: any): any {
    const periodStart = this.periodStart(limit.limitType);
    if (limit.periodStart < periodStart) {
      return { ...limit, currentUsage: BigInt(0), periodStart };
    }
    return limit;
  }
}
