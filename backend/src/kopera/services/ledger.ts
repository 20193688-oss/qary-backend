import type { PrismaClient } from '@prisma/client';

export class LedgerService {
  constructor(private prisma: PrismaClient) {}

  async listByWallet(walletId: string, filters?: {
    entryType?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = { walletId };
    if (filters?.entryType) where.entryType = filters.entryType;

    return this.prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filters?.limit ?? 50,
      skip: filters?.offset ?? 0,
    });
  }

  async getById(id: string) {
    return this.prisma.ledgerEntry.findUnique({ where: { id } });
  }

  async listByTransaction(transactionId: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { transactionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getBalanceSummary(userId: string) {
    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    return wallets.map((w: any) => ({
      walletId: w.id,
      currency: w.currency,
      balance: w.balance,
      availableBalance: w.availableBalance ?? w.balance,
      holdBalance: w.holdBalance ?? BigInt(0),
      status: w.status,
    }));
  }

  async getFlowAnalysis(walletId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    let totalCredits = BigInt(0);
    let totalDebits = BigInt(0);
    let peakBalance = BigInt(0);
    let lowestBalance = BigInt(0);
    let largestCredit = BigInt(0);
    let largestDebit = BigInt(0);
    let isFirst = true;

    for (const e of entries) {
      if (e.entryType === 'CREDIT') {
        totalCredits += e.amount;
        if (e.amount > largestCredit) largestCredit = e.amount;
      } else {
        totalDebits += e.amount;
        const absAmount = e.amount < BigInt(0) ? -e.amount : e.amount;
        if (absAmount > largestDebit) largestDebit = absAmount;
      }
      if (isFirst || e.balanceAfter > peakBalance) peakBalance = e.balanceAfter;
      if (isFirst || e.balanceAfter < lowestBalance) lowestBalance = e.balanceAfter;
      isFirst = false;
    }

    return {
      walletId,
      entryCount: entries.length,
      totalCredits,
      totalDebits,
      netFlow: totalCredits + totalDebits,
      peakBalance,
      lowestBalance,
      largestCredit,
      largestDebit,
    };
  }

  async getReconciliationReport(walletId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new Error('wallet_not_found');

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    let computedBalance = BigInt(0);
    const mismatches: Array<{ entryId: string; expected: bigint; recorded: bigint; entryType: string }> = [];
    let creditCount = 0;
    let debitCount = 0;

    for (const e of entries) {
      if (e.balanceBefore !== computedBalance) {
        mismatches.push({ entryId: e.id, expected: computedBalance, recorded: e.balanceBefore, entryType: e.entryType });
      }
      computedBalance = e.balanceAfter;
      if (e.entryType === 'CREDIT') creditCount++;
      else debitCount++;
    }

    const balanceMatchesLedger = computedBalance === wallet.balance;

    return {
      walletId,
      currency: wallet.currency,
      walletBalance: wallet.balance,
      computedBalance,
      balanceMatchesLedger,
      totalEntries: entries.length,
      creditCount,
      debitCount,
      mismatches,
      status: mismatches.length === 0 && balanceMatchesLedger ? 'clean' : 'discrepancies_found',
    };
  }

  async getAnomalyDetection(walletId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    if (entries.length === 0) {
      return { walletId, entryCount: 0, anomalies: [], riskScore: 0, riskLevel: 'low' as const };
    }

    const amounts = entries.map((e) => {
      const val = e.amount < BigInt(0) ? -e.amount : e.amount;
      return Number(val);
    });
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const stdDev = Math.sqrt(amounts.reduce((s, a) => s + (a - avg) ** 2, 0) / amounts.length);
    const threshold = avg + 3 * stdDev;

    const anomalies: Array<{ entryId: string; type: string; detail: string }> = [];

    for (const e of entries) {
      const absAmount = Number(e.amount < BigInt(0) ? -e.amount : e.amount);
      if (absAmount > threshold && threshold > 0) {
        anomalies.push({ entryId: e.id, type: 'large_amount', detail: `Amount ${absAmount} exceeds 3σ threshold ${Math.round(threshold)}` });
      }
    }

    for (let i = 1; i < entries.length; i++) {
      const gap = new Date(entries[i].createdAt).getTime() - new Date(entries[i - 1].createdAt).getTime();
      if (gap < 1000 && gap >= 0) {
        anomalies.push({ entryId: entries[i].id, type: 'rapid_sequence', detail: `Only ${gap}ms after previous entry` });
      }
    }

    for (const e of entries) {
      if (e.balanceAfter < BigInt(0)) {
        anomalies.push({ entryId: e.id, type: 'negative_balance', detail: 'Balance went negative' });
      }
    }

    let riskScore = Math.min(anomalies.length * 15, 100);
    const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : 'low';

    return { walletId, entryCount: entries.length, anomalies, riskScore, riskLevel };
  }

  async getEntryDistribution(walletId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    if (entries.length === 0) {
      return {
        walletId,
        totalEntries: 0,
        creditCount: 0,
        debitCount: 0,
        creditTotal: '0',
        debitTotal: '0',
        avgCreditAmount: '0',
        avgDebitAmount: '0',
        largestCredit: '0',
        largestDebit: '0',
        creditToDebitRatio: 0,
        byMonth: [] as Array<{ month: string; credits: number; debits: number }>,
      };
    }

    let creditCount = 0;
    let debitCount = 0;
    let creditTotal = BigInt(0);
    let debitTotal = BigInt(0);
    let largestCredit = BigInt(0);
    let largestDebit = BigInt(0);

    const monthMap = new Map<string, { credits: number; debits: number }>();

    for (const e of entries) {
      const absAmount = e.amount < BigInt(0) ? -e.amount : e.amount;
      const d = new Date(e.createdAt);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthEntry = monthMap.get(monthKey) ?? { credits: 0, debits: 0 };

      if (e.entryType === 'CREDIT') {
        creditCount++;
        creditTotal += absAmount;
        if (absAmount > largestCredit) largestCredit = absAmount;
        monthEntry.credits++;
      } else {
        debitCount++;
        debitTotal += absAmount;
        if (absAmount > largestDebit) largestDebit = absAmount;
        monthEntry.debits++;
      }
      monthMap.set(monthKey, monthEntry);
    }

    const avgCredit = creditCount > 0 ? creditTotal / BigInt(creditCount) : BigInt(0);
    const avgDebit = debitCount > 0 ? debitTotal / BigInt(debitCount) : BigInt(0);
    const creditToDebitRatio = debitCount > 0
      ? Math.round((creditCount / debitCount) * 100) / 100
      : creditCount > 0 ? creditCount : 0;

    const byMonth = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));

    return {
      walletId,
      totalEntries: entries.length,
      creditCount,
      debitCount,
      creditTotal: creditTotal.toString(),
      debitTotal: debitTotal.toString(),
      avgCreditAmount: avgCredit.toString(),
      avgDebitAmount: avgDebit.toString(),
      largestCredit: largestCredit.toString(),
      largestDebit: largestDebit.toString(),
      creditToDebitRatio,
      byMonth,
    };
  }

  async getVelocityTrend(walletId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    if (entries.length === 0) {
      return {
        walletId,
        totalEntries: 0,
        byDay: {} as Record<string, number>,
        avgPerDay: 0,
        peakDay: null as string | null,
        peakCount: 0,
        trend: 'stable' as string,
        acceleration: 0,
      };
    }

    const byDay: Record<string, number> = {};
    for (const e of entries) {
      const d = e.createdAt;
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      byDay[dayKey] = (byDay[dayKey] ?? 0) + 1;
    }

    const days = Object.keys(byDay).sort();
    const counts = days.map(d => byDay[d]);
    const avgPerDay = Math.round((counts.reduce((s, c) => s + c, 0) / counts.length) * 100) / 100;

    let peakDay: string | null = null;
    let peakCount = 0;
    for (const [day, count] of Object.entries(byDay)) {
      if (count > peakCount) { peakDay = day; peakCount = count; }
    }

    let trend = 'stable';
    let acceleration = 0;
    if (counts.length >= 2) {
      const half = Math.floor(counts.length / 2);
      const firstHalf = counts.slice(0, half).reduce((s, c) => s + c, 0) / half;
      const secondHalf = counts.slice(half).reduce((s, c) => s + c, 0) / (counts.length - half);
      acceleration = Math.round(((secondHalf - firstHalf) / (firstHalf || 1)) * 10000) / 100;
      trend = acceleration > 10 ? 'accelerating' : acceleration < -10 ? 'decelerating' : 'stable';
    }

    return {
      walletId,
      totalEntries: entries.length,
      byDay,
      avgPerDay,
      peakDay,
      peakCount,
      trend,
      acceleration,
    };
  }

  async getStatement(walletId: string, from: string, to: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        walletId,
        createdAt: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: { createdAt: 'asc' },
    });

    let totalDebits = BigInt(0);
    let totalCredits = BigInt(0);
    for (const e of entries) {
      if (e.entryType === 'DEBIT') totalDebits += e.amount;
      else totalCredits += e.amount;
    }

    const first = entries[0];
    const last = entries[entries.length - 1];

    return {
      walletId,
      from,
      to,
      entries,
      totalDebits,
      totalCredits,
      entryCount: entries.length,
      openingBalance: first ? first.balanceBefore : BigInt(0),
      closingBalance: last ? last.balanceAfter : BigInt(0),
    };
  }

  async getBalanceVolatility(walletId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    if (entries.length === 0) {
      return {
        walletId,
        totalEntries: 0,
        avgBalance: '0',
        stdDev: '0',
        coefficientOfVariation: 0,
        volatilityLevel: 'none' as const,
        largestSwing: null as { amount: string; direction: string; entryType: string } | null,
        byDay: [] as Array<{ day: string; entries: number; avgBalance: string; range: string }>,
      };
    }

    const balances = entries.map(e => Number(e.balanceAfter));
    const mean = balances.reduce((s, b) => s + b, 0) / balances.length;
    const variance = balances.reduce((s, b) => s + (b - mean) ** 2, 0) / balances.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean !== 0 ? Math.round((stdDev / Math.abs(mean)) * 10000) / 100 : 0;

    const volatilityLevel = cv > 100 ? 'extreme' as const
      : cv > 50 ? 'high' as const
      : cv > 20 ? 'moderate' as const
      : 'low' as const;

    let largestSwing: { amount: string; direction: string; entryType: string } | null = null;
    let maxSwingAbs = BigInt(0);
    for (const e of entries) {
      const swing = e.balanceAfter - e.balanceBefore;
      const absSwing = swing < BigInt(0) ? -swing : swing;
      if (absSwing > maxSwingAbs) {
        maxSwingAbs = absSwing;
        largestSwing = {
          amount: absSwing.toString(),
          direction: swing >= BigInt(0) ? 'increase' : 'decrease',
          entryType: e.entryType,
        };
      }
    }

    const dayMap = new Map<string, { balances: number[]; count: number }>();
    for (const e of entries) {
      const day = new Date(e.createdAt).toISOString().slice(0, 10);
      const entry = dayMap.get(day) ?? { balances: [], count: 0 };
      entry.balances.push(Number(e.balanceAfter));
      entry.count++;
      dayMap.set(day, entry);
    }

    const byDay = Array.from(dayMap.entries())
      .map(([day, data]) => ({
        day,
        entries: data.count,
        avgBalance: Math.round(data.balances.reduce((s, b) => s + b, 0) / data.balances.length).toString(),
        range: (Math.max(...data.balances) - Math.min(...data.balances)).toString(),
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return {
      walletId,
      totalEntries: entries.length,
      avgBalance: Math.round(mean).toString(),
      stdDev: Math.round(stdDev).toString(),
      coefficientOfVariation: cv,
      volatilityLevel,
      largestSwing,
      byDay,
    };
  }

  async getEntryFrequencyAnalysis(walletId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });

    if (entries.length === 0) {
      return {
        walletId,
        totalEntries: 0,
        avgEntriesPerDay: 0,
        peakDay: null as string | null,
        quietestDay: null as string | null,
        byDayOfWeek: [] as Array<{ day: string; count: number; percent: number }>,
        burstDays: [] as Array<{ date: string; count: number }>,
        activityPattern: 'none' as const,
      };
    }

    const dayMap = new Map<string, number>();
    const dayOfWeekCounts = new Array(7).fill(0);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (const e of entries) {
      const d = new Date(e.createdAt);
      const dateKey = d.toISOString().slice(0, 10);
      dayMap.set(dateKey, (dayMap.get(dateKey) ?? 0) + 1);
      dayOfWeekCounts[d.getUTCDay()]++;
    }

    const dayCounts = Array.from(dayMap.entries());
    const totalDays = dayCounts.length;
    const avgEntriesPerDay = totalDays > 0
      ? Math.round((entries.length / totalDays) * 100) / 100
      : 0;

    dayCounts.sort((a, b) => b[1] - a[1]);
    const peakDay = dayCounts[0]?.[0] ?? null;
    const quietestDay = dayCounts[dayCounts.length - 1]?.[0] ?? null;

    const byDayOfWeek = dayNames.map((day, i) => ({
      day,
      count: dayOfWeekCounts[i],
      percent: entries.length > 0 ? Math.round((dayOfWeekCounts[i] / entries.length) * 10000) / 100 : 0,
    }));

    const burstThreshold = avgEntriesPerDay * 3;
    const burstDays = dayCounts
      .filter(([, count]) => count >= burstThreshold && count >= 3)
      .slice(0, 5)
      .map(([date, count]) => ({ date, count }));

    const weekday = dayOfWeekCounts.slice(1, 6).reduce((s: number, c: number) => s + c, 0);
    const weekend = dayOfWeekCounts[0] + dayOfWeekCounts[6];
    const activityPattern = weekend === 0 && weekday > 0 ? 'weekday_only' as const
      : weekday === 0 && weekend > 0 ? 'weekend_only' as const
      : weekday > weekend * 3 ? 'weekday_heavy' as const
      : 'balanced' as const;

    return {
      walletId,
      totalEntries: entries.length,
      avgEntriesPerDay,
      peakDay,
      quietestDay,
      byDayOfWeek,
      burstDays,
      activityPattern,
    };
  }
}
