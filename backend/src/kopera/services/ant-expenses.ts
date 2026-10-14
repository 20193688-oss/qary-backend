import type { PrismaClient } from '@prisma/client';

export class AntExpenseService {
  constructor(private prisma: PrismaClient) {}

  async detect(userId: string, data: {
    category: string;
    merchantName: string;
    amount: bigint;
    currency: string;
    frequency: string;
    monthlyTotal: bigint;
    yearlyProjection: bigint;
    suggestion?: string;
    savingsIfCut?: bigint;
  }) {
    const existing = await this.prisma.antExpense.findFirst({
      where: { userId, merchantName: data.merchantName, category: data.category, isActive: true },
    });
    if (existing) throw new Error('expense_already_tracked');

    return this.prisma.antExpense.create({
      data: { userId, ...data },
    });
  }

  async listActive(userId: string) {
    return this.prisma.antExpense.findMany({
      where: { userId, isActive: true },
    });
  }

  async getById(id: string) {
    return this.prisma.antExpense.findUnique({ where: { id } });
  }

  async getSummary(userId: string, currency: string) {
    const expenses = await this.prisma.antExpense.findMany({
      where: { userId, isActive: true, currency: currency.toUpperCase() },
    });

    let totalMonthly = BigInt(0);
    let totalYearly = BigInt(0);
    let totalSavingsIfCut = BigInt(0);

    for (const e of expenses) {
      totalMonthly += e.monthlyTotal;
      totalYearly += e.yearlyProjection;
      if (e.savingsIfCut) totalSavingsIfCut += e.savingsIfCut;
    }

    return {
      currency: currency.toUpperCase(),
      count: expenses.length,
      totalMonthly,
      totalYearly,
      totalSavingsIfCut,
    };
  }

  async reactivate(id: string, userId: string) {
    const expense = await this.prisma.antExpense.findUnique({ where: { id } });
    if (!expense) throw new Error('expense_not_found');
    if (expense.userId !== userId) throw new Error('forbidden');
    if (expense.isActive) throw new Error('already_active');

    return this.prisma.antExpense.update({
      where: { id },
      data: { isActive: true },
    });
  }

  async getCategoryBreakdown(userId: string, currency: string) {
    const expenses = await this.prisma.antExpense.findMany({
      where: { userId, isActive: true, currency: currency.toUpperCase() },
    });

    const categories: Record<string, { count: number; monthlyTotal: bigint; yearlyProjection: bigint }> = {};
    for (const e of expenses) {
      if (!categories[e.category]) {
        categories[e.category] = { count: 0, monthlyTotal: BigInt(0), yearlyProjection: BigInt(0) };
      }
      categories[e.category].count++;
      categories[e.category].monthlyTotal += e.monthlyTotal;
      categories[e.category].yearlyProjection += e.yearlyProjection;
    }

    return Object.entries(categories).map(([category, data]) => ({
      category,
      count: data.count,
      monthlyTotal: data.monthlyTotal,
      yearlyProjection: data.yearlyProjection,
    })).sort((a, b) => Number(b.monthlyTotal - a.monthlyTotal));
  }

  async listDismissed(userId: string) {
    return this.prisma.antExpense.findMany({
      where: { userId, isActive: false },
    });
  }

  async getSavingsImpactReport(userId: string) {
    const all = await this.prisma.antExpense.findMany({ where: { userId } });
    const active = all.filter((e: any) => e.isActive);
    const dismissed = all.filter((e: any) => !e.isActive);

    const byCurrency: Record<string, { monthlyTotal: bigint; potentialSavings: bigint; count: number }> = {};
    let highestImpact: { merchantName: string; category: string; currency: string; savingsIfCut: bigint } | null = null;

    for (const e of active) {
      if (!byCurrency[e.currency]) byCurrency[e.currency] = { monthlyTotal: BigInt(0), potentialSavings: BigInt(0), count: 0 };
      byCurrency[e.currency].monthlyTotal += e.monthlyTotal;
      byCurrency[e.currency].count++;
      if (e.savingsIfCut) {
        byCurrency[e.currency].potentialSavings += e.savingsIfCut;
        if (!highestImpact || e.savingsIfCut > highestImpact.savingsIfCut) {
          highestImpact = { merchantName: e.merchantName, category: e.category, currency: e.currency, savingsIfCut: e.savingsIfCut };
        }
      }
    }

    return {
      totalTracked: all.length,
      activeCount: active.length,
      dismissedCount: dismissed.length,
      byCurrency,
      highestImpact,
    };
  }

  async getTrendAnalysis(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({ where: { userId } });
    const active = expenses.filter((e: any) => e.isActive);
    const dismissed = expenses.filter((e: any) => !e.isActive);

    const byFrequency: Record<string, { count: number; totalMonthly: bigint }> = {};
    let totalActiveMonthly = BigInt(0);
    let totalDismissedMonthly = BigInt(0);

    const topMerchants: { merchantName: string; category: string; monthlyTotal: bigint; currency: string }[] = [];

    for (const e of expenses) {
      if (!byFrequency[e.frequency]) byFrequency[e.frequency] = { count: 0, totalMonthly: BigInt(0) };
      byFrequency[e.frequency].count++;
      byFrequency[e.frequency].totalMonthly += e.monthlyTotal;

      if (e.isActive) {
        totalActiveMonthly += e.monthlyTotal;
        topMerchants.push({ merchantName: e.merchantName, category: e.category, monthlyTotal: e.monthlyTotal, currency: e.currency });
      } else {
        totalDismissedMonthly += e.monthlyTotal;
      }
    }

    topMerchants.sort((a, b) => Number(b.monthlyTotal - a.monthlyTotal));

    const avgPerExpense = active.length > 0
      ? totalActiveMonthly / BigInt(active.length)
      : BigInt(0);

    return {
      totalExpenses: expenses.length,
      activeCount: active.length,
      dismissedCount: dismissed.length,
      totalActiveMonthly,
      totalDismissedMonthly,
      avgPerExpense,
      byFrequency,
      topMerchants: topMerchants.slice(0, 5),
    };
  }

  async getMerchantConcentration(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({ where: { userId, isActive: true } });

    if (expenses.length === 0) {
      return {
        totalMerchants: 0,
        totalMonthlySpend: '0',
        herfindahlIndex: 0,
        concentrationLevel: 'none' as const,
        merchantShares: [] as { merchantName: string; category: string; currency: string; monthlyTotal: string; sharePercent: number }[],
        dominantMerchant: null as { merchantName: string; category: string; sharePercent: number } | null,
        recommendations: [] as string[],
      };
    }

    let totalMonthly = BigInt(0);
    for (const e of expenses) totalMonthly += e.monthlyTotal;

    const merchantShares = expenses.map(e => {
      const sharePercent = totalMonthly > BigInt(0)
        ? Math.round(Number(e.monthlyTotal * BigInt(10000) / totalMonthly)) / 100
        : 0;
      return {
        merchantName: e.merchantName,
        category: e.category,
        currency: e.currency,
        monthlyTotal: e.monthlyTotal.toString(),
        sharePercent,
      };
    }).sort((a, b) => b.sharePercent - a.sharePercent);

    let hhi = 0;
    for (const s of merchantShares) hhi += s.sharePercent * s.sharePercent;
    hhi = Math.round(hhi);

    const concentrationLevel = hhi > 5000 ? 'high' : hhi > 2500 ? 'moderate' : 'low';
    const dominantMerchant = merchantShares[0] && merchantShares[0].sharePercent > 40
      ? { merchantName: merchantShares[0].merchantName, category: merchantShares[0].category, sharePercent: merchantShares[0].sharePercent }
      : null;

    const recommendations: string[] = [];
    if (concentrationLevel === 'high') recommendations.push('Spending is highly concentrated — consider diversifying');
    if (dominantMerchant) recommendations.push(`${dominantMerchant.merchantName} accounts for ${dominantMerchant.sharePercent}% of spending`);

    return {
      totalMerchants: expenses.length,
      totalMonthlySpend: totalMonthly.toString(),
      herfindahlIndex: hhi,
      concentrationLevel,
      merchantShares,
      dominantMerchant,
      recommendations,
    };
  }

  async getActionPlan(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({ where: { userId, isActive: true } });

    if (expenses.length === 0) {
      return {
        totalExpenses: 0,
        totalMonthlyCost: '0',
        totalPotentialSavings: '0',
        actions: [] as Array<{ merchantName: string; category: string; currency: string; monthlyTotal: string; savingsIfCut: string; priority: string; suggestion: string | null }>,
        summary: { highPriority: 0, mediumPriority: 0, lowPriority: 0 },
      };
    }

    let totalMonthlyCost = BigInt(0);
    let totalPotentialSavings = BigInt(0);

    const actions = expenses.map(e => {
      totalMonthlyCost += e.monthlyTotal;
      const savings = e.savingsIfCut ?? BigInt(0);
      totalPotentialSavings += savings;

      const savingsRatio = e.monthlyTotal > BigInt(0) && savings > BigInt(0)
        ? Number(savings * BigInt(100) / e.monthlyTotal)
        : 0;
      const priority = savingsRatio >= 50 ? 'high' : savingsRatio >= 20 ? 'medium' : 'low';

      return {
        merchantName: e.merchantName,
        category: e.category,
        currency: e.currency,
        monthlyTotal: e.monthlyTotal.toString(),
        savingsIfCut: savings.toString(),
        priority,
        suggestion: e.suggestion ?? null,
      };
    });

    const priorityOrder = { high: 0, medium: 1, low: 2 };
    actions.sort((a, b) => (priorityOrder[a.priority as keyof typeof priorityOrder] - priorityOrder[b.priority as keyof typeof priorityOrder]) || (Number(BigInt(b.savingsIfCut) - BigInt(a.savingsIfCut))));

    const summary = {
      highPriority: actions.filter(a => a.priority === 'high').length,
      mediumPriority: actions.filter(a => a.priority === 'medium').length,
      lowPriority: actions.filter(a => a.priority === 'low').length,
    };

    return {
      totalExpenses: expenses.length,
      totalMonthlyCost: totalMonthlyCost.toString(),
      totalPotentialSavings: totalPotentialSavings.toString(),
      actions,
      summary,
    };
  }

  async dismiss(id: string, userId: string) {
    const expense = await this.prisma.antExpense.findUnique({ where: { id } });
    if (!expense) throw new Error('expense_not_found');
    if (expense.userId !== userId) throw new Error('forbidden');
    if (!expense.isActive) throw new Error('already_dismissed');

    return this.prisma.antExpense.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async getCategoryRiskScore(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({
      where: { userId, isActive: true },
    });

    if (expenses.length === 0) {
      return {
        totalActiveExpenses: 0,
        overallRiskScore: 0,
        riskLevel: 'none' as const,
        byCategory: [],
      };
    }

    const byCategory = new Map<string, { count: number; totalAmount: bigint; merchants: Set<string> }>();
    for (const e of expenses) {
      const cat = e.category ?? 'uncategorized';
      const entry = byCategory.get(cat) ?? { count: 0, totalAmount: BigInt(0), merchants: new Set<string>() };
      entry.count++;
      entry.totalAmount += e.amount;
      if (e.merchantName) entry.merchants.add(e.merchantName);
      byCategory.set(cat, entry);
    }

    const totalAmount = expenses.reduce((s, e) => s + e.amount, BigInt(0));
    const categories = Array.from(byCategory.entries()).map(([category, data]) => {
      const share = totalAmount > BigInt(0)
        ? Number((data.totalAmount * BigInt(10000)) / totalAmount) / 100
        : 0;
      const concentrationScore = Math.min(100, share);
      const frequencyScore = Math.min(100, (data.count / expenses.length) * 100);
      const merchantDiversity = data.merchants.size;
      const diversityPenalty = merchantDiversity <= 1 ? 30 : merchantDiversity <= 2 ? 15 : 0;
      const riskScore = Math.round((concentrationScore * 0.5 + frequencyScore * 0.3 + diversityPenalty * 0.2) * 100) / 100;

      return {
        category,
        count: data.count,
        totalAmount: data.totalAmount.toString(),
        share: Math.round(share * 100) / 100,
        merchantCount: merchantDiversity,
        riskScore,
      };
    }).sort((a, b) => b.riskScore - a.riskScore);

    const overallRiskScore = Math.round(
      (categories.reduce((s, c) => s + c.riskScore, 0) / categories.length) * 100
    ) / 100;

    let riskLevel: 'high' | 'medium' | 'low' | 'none';
    if (overallRiskScore >= 60) riskLevel = 'high';
    else if (overallRiskScore >= 30) riskLevel = 'medium';
    else riskLevel = 'low';

    return {
      totalActiveExpenses: expenses.length,
      overallRiskScore,
      riskLevel,
      byCategory: categories,
    };
  }

  async getSeasonalPattern(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({ where: { userId } });

    if (expenses.length === 0) {
      return {
        totalExpenses: 0,
        byMonth: [],
        peakMonth: null,
        lowMonth: null,
        seasonalityIndex: 0,
        pattern: 'none' as const,
      };
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthData = new Array(12).fill(null).map(() => ({ count: 0, totalAmount: BigInt(0) }));

    for (const e of expenses) {
      const month = new Date((e as any).createdAt).getMonth();
      monthData[month].count++;
      monthData[month].totalAmount += e.amount;
    }

    const byMonth = monthData.map((d, i) => ({
      month: monthNames[i],
      monthIndex: i,
      count: d.count,
      totalAmount: d.totalAmount.toString(),
    }));

    const counts = monthData.map(d => d.count);
    const avgCount = counts.reduce((a, b) => a + b, 0) / 12;

    let peakMonth: string | null = null;
    let lowMonth: string | null = null;
    let maxCount = 0;
    let minCount = Infinity;

    for (let i = 0; i < 12; i++) {
      if (counts[i] > maxCount) { maxCount = counts[i]; peakMonth = monthNames[i]; }
      if (counts[i] < minCount) { minCount = counts[i]; lowMonth = monthNames[i]; }
    }

    const variance = avgCount > 0
      ? counts.reduce((s, c) => s + (c - avgCount) ** 2, 0) / 12
      : 0;
    const cv = avgCount > 0 ? Math.sqrt(variance) / avgCount : 0;
    const seasonalityIndex = Math.round(cv * 10000) / 100;

    const pattern = seasonalityIndex > 50 ? 'highly_seasonal'
      : seasonalityIndex > 20 ? 'seasonal'
      : seasonalityIndex > 5 ? 'mild'
      : 'none';

    return {
      totalExpenses: expenses.length,
      byMonth,
      peakMonth,
      lowMonth,
      seasonalityIndex,
      pattern,
    };
  }

  async getRecurringExpenseDetection(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({ where: { userId } });
    if (expenses.length === 0) {
      return {
        totalExpenses: 0,
        recurringCount: 0,
        oneTimeCount: 0,
        recurringMonthlyTotal: '0',
        patterns: [],
      };
    }

    const merchantAmounts = new Map<string, { amounts: bigint[]; dates: Date[] }>();
    for (const e of expenses) {
      const key = (e as any).merchantName || (e as any).description || 'unknown';
      if (!merchantAmounts.has(key)) {
        merchantAmounts.set(key, { amounts: [], dates: [] });
      }
      const entry = merchantAmounts.get(key)!;
      entry.amounts.push((e as any).amount ?? BigInt(0));
      entry.dates.push(e.createdAt);
    }

    const patterns: { merchant: string; occurrences: number; avgAmount: string; frequency: string; confidence: number }[] = [];
    let recurringCount = 0;

    for (const [merchant, data] of merchantAmounts.entries()) {
      if (data.amounts.length < 2) continue;

      const sorted = data.dates.slice().sort((a, b) => a.getTime() - b.getTime());
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push((sorted[i].getTime() - sorted[i - 1].getTime()) / 86400000);
      }
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const gapVariance = gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length;
      const gapStdDev = Math.sqrt(gapVariance);
      const consistency = avgGap > 0 ? Math.max(0, 100 - (gapStdDev / avgGap) * 100) : 0;

      let frequency = 'irregular';
      if (avgGap <= 10 && consistency > 40) frequency = 'weekly';
      else if (avgGap <= 20 && consistency > 30) frequency = 'biweekly';
      else if (avgGap <= 45 && consistency > 25) frequency = 'monthly';
      else if (avgGap <= 100 && consistency > 20) frequency = 'quarterly';

      if (frequency !== 'irregular' && consistency > 20) {
        const totalAmount = data.amounts.reduce((s, a) => s + a, BigInt(0));
        const avgAmount = totalAmount / BigInt(data.amounts.length);
        patterns.push({
          merchant,
          occurrences: data.amounts.length,
          avgAmount: avgAmount.toString(),
          frequency,
          confidence: Math.round(consistency),
        });
        recurringCount += data.amounts.length;
      }
    }

    patterns.sort((a, b) => b.confidence - a.confidence);
    const monthlyTotal = patterns.reduce((s, p) => {
      const amt = BigInt(p.avgAmount);
      const multiplier = p.frequency === 'weekly' ? 4 : p.frequency === 'biweekly' ? 2 : p.frequency === 'quarterly' ? 1 : 1;
      return s + amt * BigInt(multiplier);
    }, BigInt(0));

    return {
      totalExpenses: expenses.length,
      recurringCount,
      oneTimeCount: expenses.length - recurringCount,
      recurringMonthlyTotal: monthlyTotal.toString(),
      patterns: patterns.slice(0, 10),
    };
  }

  async getExpenseVelocityReport(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (expenses.length === 0) {
      return {
        totalExpenses: 0,
        dailyAverage: 0,
        weeklyAverage: 0,
        acceleration: 'none' as const,
        recentTrend: 'none' as const,
        periodComparison: null,
      };
    }

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86400000;
    const sixtyDaysAgo = now - 60 * 86400000;

    const recent = expenses.filter(e => new Date(e.createdAt).getTime() >= thirtyDaysAgo);
    const prior = expenses.filter(e => {
      const t = new Date(e.createdAt).getTime();
      return t >= sixtyDaysAgo && t < thirtyDaysAgo;
    });

    const firstDate = new Date(expenses[0].createdAt).getTime();
    const totalDays = Math.max(1, (now - firstDate) / 86400000);
    const dailyAverage = Math.round((expenses.length / totalDays) * 100) / 100;
    const weeklyAverage = Math.round(dailyAverage * 7 * 100) / 100;

    const recentRate = recent.length / 30;
    const priorRate = prior.length / 30;

    let acceleration: 'accelerating' | 'decelerating' | 'stable' | 'none' = 'stable';
    if (priorRate > 0) {
      const change = (recentRate - priorRate) / priorRate;
      if (change > 0.2) acceleration = 'accelerating';
      else if (change < -0.2) acceleration = 'decelerating';
    }

    const recentTotal = recent.reduce((s, e) => s + (e.amount ?? BigInt(0)), BigInt(0));
    const priorTotal = prior.reduce((s, e) => s + (e.amount ?? BigInt(0)), BigInt(0));

    const recentTrend = recent.length > prior.length ? 'increasing' as const
      : recent.length < prior.length ? 'decreasing' as const
      : 'stable' as const;

    return {
      totalExpenses: expenses.length,
      dailyAverage,
      weeklyAverage,
      acceleration,
      recentTrend,
      periodComparison: {
        last30Days: { count: recent.length, total: recentTotal.toString() },
        prior30Days: { count: prior.length, total: priorTotal.toString() },
      },
    };
  }

  async getExpenseBudgetAlignment(userId: string) {
    const expenses = await this.prisma.antExpense.findMany({ where: { userId } });

    if (expenses.length === 0) {
      return {
        totalExpenses: 0,
        totalSpent: '0',
        avgMonthlySpend: '0',
        categorySpending: [] as { category: string; total: string; count: number; percentOfTotal: number }[],
        budgetHealth: 'no_data' as const,
        recommendations: [] as string[],
      };
    }

    let totalSpent = BigInt(0);
    const categoryMap = new Map<string, { total: bigint; count: number }>();

    for (const e of expenses) {
      const amount = (e as any).amount ?? BigInt(0);
      totalSpent += amount;
      const category = ((e as any).category || 'uncategorized').toLowerCase();
      const existing = categoryMap.get(category) || { total: BigInt(0), count: 0 };
      existing.total += amount;
      existing.count++;
      categoryMap.set(category, existing);
    }

    const categorySpending = Array.from(categoryMap.entries())
      .map(([category, data]) => ({
        category,
        total: data.total.toString(),
        count: data.count,
        percentOfTotal: totalSpent > BigInt(0)
          ? Number(data.total * BigInt(10000) / totalSpent) / 100
          : 0,
      }))
      .sort((a, b) => b.percentOfTotal - a.percentOfTotal);

    const earliest = new Date(Math.min(...expenses.map(e => new Date(e.createdAt).getTime())));
    const months = Math.max(1, Math.ceil((Date.now() - earliest.getTime()) / (30 * 86400000)));
    const avgMonthly = totalSpent / BigInt(months);

    const topCategoryShare = categorySpending[0]?.percentOfTotal ?? 0;
    const budgetHealth = topCategoryShare > 70 ? 'concentrated' as const
      : categorySpending.length <= 2 ? 'narrow' as const
      : 'diversified' as const;

    const recommendations: string[] = [];
    if (budgetHealth === 'concentrated') recommendations.push(`Top category accounts for ${topCategoryShare}% of spending — consider diversifying`);
    if (categorySpending.length > 10) recommendations.push('Many small expense categories — consider consolidating tracking');
    if (avgMonthly > BigInt(0)) recommendations.push(`Average monthly spend: ${avgMonthly.toString()} — review against budget targets`);

    return {
      totalExpenses: expenses.length,
      totalSpent: totalSpent.toString(),
      avgMonthlySpend: avgMonthly.toString(),
      categorySpending,
      budgetHealth,
      recommendations,
    };
  }
}
