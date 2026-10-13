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
}
