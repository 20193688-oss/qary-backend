import type { PrismaClient } from '@prisma/client';

export class TransactionService {
  constructor(private prisma: PrismaClient) {}

  async listTransactions(userId: string, filters?: {
    type?: string;
    status?: string;
    currency?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = { userId };
    if (filters?.type) where.type = filters.type;
    if (filters?.status) where.status = filters.status;
    if (filters?.currency) where.currency = filters.currency.toUpperCase();

    const allRows = await this.prisma.transaction.findMany({ where });

    let filtered = allRows;
    if (filters?.from || filters?.to) {
      filtered = allRows.filter((t: any) => {
        const ts = new Date(t.createdAt).getTime();
        if (filters.from && ts < filters.from.getTime()) return false;
        if (filters.to && ts > filters.to.getTime()) return false;
        return true;
      });
    }

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async listByWallet(walletId: string, userId: string, limit = 50, offset = 0) {
    const all = await this.prisma.transaction.findMany({
      where: { userId },
    });
    const walletTxns = all.filter((t: any) =>
      t.senderWalletId === walletId || t.receiverWalletId === walletId,
    );
    return { rows: walletTxns.slice(offset, offset + limit), total: walletTxns.length };
  }

  async getTransaction(id: string, userId: string) {
    const txn = await this.prisma.transaction.findUnique({ where: { id } });
    if (!txn || txn.userId !== userId) return null;
    return txn;
  }

  async getByReference(reference: string, userId: string) {
    const txn = await this.prisma.transaction.findFirst({
      where: { reference, userId },
    });
    return txn;
  }

  async getSummary(userId: string, currency: string) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId, currency: currency.toUpperCase(), status: 'COMPLETED' },
    });

    let totalIn = BigInt(0);
    let totalOut = BigInt(0);
    let count = 0;

    for (const t of txns) {
      count++;
      if (t.type === 'DEPOSIT' || t.type === 'REWARD') {
        totalIn += t.amount;
      } else if (t.type === 'WITHDRAWAL' || t.type === 'PAYMENT' || t.type === 'FEE') {
        totalOut += t.amount;
      } else if (t.type === 'TRANSFER') {
        if (t.receiverWalletId && !t.senderWalletId) {
          totalIn += t.amount;
        } else {
          totalOut += t.amount;
        }
      }
    }

    return { currency: currency.toUpperCase(), totalIn, totalOut, count };
  }

  async getMonthlyBreakdown(userId: string, currency: string, year: number) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId, currency: currency.toUpperCase(), status: 'COMPLETED' },
    });

    const months: Array<{ month: number; totalIn: bigint; totalOut: bigint; transactionCount: number }> = [];
    for (let m = 1; m <= 12; m++) {
      months.push({ month: m, totalIn: BigInt(0), totalOut: BigInt(0), transactionCount: 0 });
    }

    for (const t of txns) {
      const d = new Date(t.createdAt);
      if (d.getFullYear() !== year) continue;
      const bucket = months[d.getMonth()];
      bucket.transactionCount++;
      if (t.type === 'DEPOSIT' || t.type === 'REWARD') {
        bucket.totalIn += t.amount;
      } else if (t.type === 'WITHDRAWAL' || t.type === 'PAYMENT' || t.type === 'FEE' || t.type === 'TRANSFER') {
        bucket.totalOut += t.amount;
      }
    }

    return months;
  }

  async getTypeDistribution(userId: string, currency?: string) {
    const where: Record<string, unknown> = { userId, status: 'COMPLETED' };
    if (currency) where.currency = currency.toUpperCase();
    const txns = await this.prisma.transaction.findMany({ where });

    const byType: Record<string, { count: number; totalAmount: bigint }> = {};
    for (const t of txns) {
      if (!byType[t.type]) byType[t.type] = { count: 0, totalAmount: BigInt(0) };
      byType[t.type].count++;
      byType[t.type].totalAmount += t.amount;
    }

    return { totalTransactions: txns.length, byType };
  }

  async getVelocityReport(userId: string, currency?: string) {
    const where: Record<string, unknown> = { userId, status: 'COMPLETED' };
    if (currency) where.currency = currency.toUpperCase();
    const txns = await this.prisma.transaction.findMany({ where });

    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        dailyAverage: 0,
        weeklyAverage: 0,
        peakDay: null,
        largestTransaction: null,
        trendComparison: null,
      };
    }

    const byDay: Record<string, { count: number; volume: bigint }> = {};
    let largestTxn: { id: string; amount: bigint; type: string; createdAt: Date } | null = null;

    for (const t of txns) {
      const day = new Date(t.createdAt).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { count: 0, volume: BigInt(0) };
      byDay[day].count++;
      byDay[day].volume += t.amount;
      if (!largestTxn || t.amount > largestTxn.amount) {
        largestTxn = { id: t.id, amount: t.amount, type: t.type, createdAt: t.createdAt };
      }
    }

    const dayKeys = Object.keys(byDay).sort();
    const totalDays = Math.max(1, dayKeys.length);
    const dailyAverage = Math.round(txns.length / totalDays * 10) / 10;
    const weeklyAverage = Math.round(dailyAverage * 7 * 10) / 10;

    let peakDay: { date: string; count: number; volume: bigint } | null = null;
    for (const [date, data] of Object.entries(byDay)) {
      if (!peakDay || data.count > peakDay.count) {
        peakDay = { date, count: data.count, volume: data.volume };
      }
    }

    const now = Date.now();
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
    const twentyEightDaysAgo = now - 28 * 24 * 60 * 60 * 1000;
    const recentCount = txns.filter((t: any) => new Date(t.createdAt).getTime() >= fourteenDaysAgo).length;
    const priorCount = txns.filter((t: any) => {
      const ts = new Date(t.createdAt).getTime();
      return ts >= twentyEightDaysAgo && ts < fourteenDaysAgo;
    }).length;

    const trendComparison = {
      last14Days: recentCount,
      prior14Days: priorCount,
      changePercent: priorCount > 0
        ? Math.round((recentCount - priorCount) / priorCount * 10000) / 100
        : null,
    };

    return {
      totalTransactions: txns.length,
      dailyAverage,
      weeklyAverage,
      peakDay: peakDay ? { ...peakDay, volume: peakDay.volume } : null,
      largestTransaction: largestTxn ? { ...largestTxn, amount: largestTxn.amount } : null,
      trendComparison,
    };
  }

  async getCounterpartyReport(userId: string) {
    const txns = await this.prisma.transaction.findMany({ where: { userId, status: 'COMPLETED' } });

    const byCounterparty: Record<string, { count: number; totalSent: bigint; totalReceived: bigint; currencies: Set<string>; lastTransaction: Date | null }> = {};

    for (const t of txns) {
      const name = (t as any).counterpartyName ?? 'unknown';
      if (!byCounterparty[name]) {
        byCounterparty[name] = { count: 0, totalSent: BigInt(0), totalReceived: BigInt(0), currencies: new Set(), lastTransaction: null };
      }
      const entry = byCounterparty[name];
      entry.count++;
      entry.currencies.add(t.currency);
      const txDate = t.processedAt ?? t.createdAt;
      if (!entry.lastTransaction || txDate > entry.lastTransaction) entry.lastTransaction = txDate;

      if (t.type === 'WITHDRAWAL' || t.type === 'PAYMENT' || (t.type === 'TRANSFER' && t.senderWalletId)) {
        entry.totalSent += t.amount;
      } else {
        entry.totalReceived += t.amount;
      }
    }

    const counterparties = Object.entries(byCounterparty)
      .map(([name, data]) => ({
        name,
        count: data.count,
        totalSent: data.totalSent,
        totalReceived: data.totalReceived,
        currencies: [...data.currencies],
        lastTransaction: data.lastTransaction,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCounterparties: counterparties.length,
      totalTransactions: txns.length,
      topCounterparties: counterparties.slice(0, 10),
    };
  }

  async getCashFlowForecast(userId: string, currency: string, forecastDays: number = 30) {
    const cur = currency.toUpperCase();
    const txns = await this.prisma.transaction.findMany({
      where: { userId, currency: cur, status: 'COMPLETED' },
    });

    if (txns.length === 0) {
      return {
        currency: cur,
        forecastDays,
        historicalDays: 0,
        avgDailyInflow: BigInt(0),
        avgDailyOutflow: BigInt(0),
        projectedNetFlow: BigInt(0),
        confidence: 'none' as const,
        byType: {},
      };
    }

    const dates = txns.map((t) => new Date(t.createdAt).getTime());
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const historicalDays = Math.max(1, Math.round((maxDate - minDate) / (24 * 60 * 60 * 1000)));

    let totalInflow = BigInt(0);
    let totalOutflow = BigInt(0);
    const byType: Record<string, { count: number; total: bigint; direction: string }> = {};

    for (const t of txns) {
      const isInflow = t.type === 'DEPOSIT' || t.type === 'REWARD' ||
        (t.type === 'TRANSFER' && t.receiverWalletId && !t.senderWalletId);

      if (isInflow) {
        totalInflow += t.amount;
      } else {
        totalOutflow += t.amount;
      }

      const dir = isInflow ? 'inflow' : 'outflow';
      if (!byType[t.type]) byType[t.type] = { count: 0, total: BigInt(0), direction: dir };
      byType[t.type].count++;
      byType[t.type].total += t.amount;
    }

    const avgDailyInflow = totalInflow / BigInt(historicalDays);
    const avgDailyOutflow = totalOutflow / BigInt(historicalDays);
    const projectedNetFlow = (avgDailyInflow - avgDailyOutflow) * BigInt(forecastDays);

    const confidence = historicalDays >= 30 ? 'high' : historicalDays >= 7 ? 'medium' : 'low';

    return {
      currency: cur,
      forecastDays,
      historicalDays,
      avgDailyInflow,
      avgDailyOutflow,
      projectedNetFlow,
      confidence,
      byType,
    };
  }

  async getRecurringPatterns(userId: string) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId, status: 'COMPLETED' },
    });

    if (txns.length === 0) {
      return { totalTransactions: 0, patternsDetected: 0, patterns: [] };
    }

    const groups: Record<string, { count: number; dates: Date[]; type: string; counterparty: string; amount: bigint; currency: string }> = {};

    for (const t of txns) {
      const counterparty = (t as any).counterpartyName ?? 'unknown';
      const key = `${counterparty}|${t.type}|${t.amount}|${t.currency}`;
      if (!groups[key]) {
        groups[key] = { count: 0, dates: [], type: t.type, counterparty, amount: t.amount, currency: t.currency };
      }
      groups[key].count++;
      groups[key].dates.push(new Date(t.createdAt));
    }

    const patterns = Object.values(groups)
      .filter(g => g.count >= 2)
      .map(g => {
        const sortedDates = g.dates.sort((a, b) => a.getTime() - b.getTime());
        let totalGapDays = 0;
        for (let i = 1; i < sortedDates.length; i++) {
          totalGapDays += (sortedDates[i].getTime() - sortedDates[i - 1].getTime()) / (1000 * 60 * 60 * 24);
        }
        const avgGapDays = sortedDates.length > 1
          ? Math.round(totalGapDays / (sortedDates.length - 1) * 10) / 10
          : 0;

        let estimatedFrequency: string;
        if (avgGapDays <= 2) estimatedFrequency = 'daily';
        else if (avgGapDays <= 10) estimatedFrequency = 'weekly';
        else if (avgGapDays <= 45) estimatedFrequency = 'monthly';
        else estimatedFrequency = 'irregular';

        return {
          counterparty: g.counterparty,
          type: g.type,
          amount: g.amount.toString(),
          currency: g.currency,
          occurrences: g.count,
          avgGapDays,
          estimatedFrequency,
          firstSeen: sortedDates[0],
          lastSeen: sortedDates[sortedDates.length - 1],
        };
      })
      .sort((a, b) => b.occurrences - a.occurrences);

    return { totalTransactions: txns.length, patternsDetected: patterns.length, patterns };
  }

  async searchTransactions(userId: string, query: string, opts?: { limit?: number }) {
    const all = await this.prisma.transaction.findMany({ where: { userId } });
    const q = query.toLowerCase();
    const matched = all.filter((t: any) =>
      (t.description && t.description.toLowerCase().includes(q)) ||
      (t.reference && t.reference.toLowerCase().includes(q)) ||
      (t.counterpartyName && t.counterpartyName.toLowerCase().includes(q))
    );
    const limit = Math.min(opts?.limit ?? 50, 100);
    return matched.slice(0, limit);
  }

  async getFeeAnalysis(userId: string, currency?: string) {
    const where: Record<string, unknown> = { userId, status: 'COMPLETED' };
    if (currency) where.currency = currency.toUpperCase();

    const txns = await this.prisma.transaction.findMany({ where });

    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        totalFees: '0',
        avgFeePerTransaction: '0',
        feeToAmountRatio: 0,
        byType: {},
      };
    }

    let totalFees = BigInt(0);
    let totalAmount = BigInt(0);
    const typeMap = new Map<string, { count: number; fees: bigint; amounts: bigint }>();

    for (const t of txns) {
      const fee = (t as any).feeAmount ?? BigInt(0);
      totalFees += fee;
      totalAmount += t.amount;

      const type = t.type;
      const entry = typeMap.get(type) ?? { count: 0, fees: BigInt(0), amounts: BigInt(0) };
      entry.count++;
      entry.fees += fee;
      entry.amounts += t.amount;
      typeMap.set(type, entry);
    }

    const avgFee = txns.length > 0 ? totalFees / BigInt(txns.length) : BigInt(0);
    const feeToAmountRatio = Number(totalAmount) > 0
      ? Math.round(Number(totalFees) * 10000 / Number(totalAmount)) / 100
      : 0;

    const byType: Record<string, any> = {};
    for (const [type, data] of typeMap) {
      byType[type] = {
        count: data.count,
        totalFees: data.fees.toString(),
        avgFee: (data.count > 0 ? data.fees / BigInt(data.count) : BigInt(0)).toString(),
        feeToAmountRatio: Number(data.amounts) > 0
          ? Math.round(Number(data.fees) * 10000 / Number(data.amounts)) / 100
          : 0,
      };
    }

    return {
      totalTransactions: txns.length,
      totalFees: totalFees.toString(),
      avgFeePerTransaction: avgFee.toString(),
      feeToAmountRatio,
      byType,
    };
  }

  async getAmountDistribution(userId: string, currency?: string) {
    const where: Record<string, unknown> = { userId, status: 'COMPLETED' };
    if (currency) where.currency = currency.toUpperCase();
    const txns = await this.prisma.transaction.findMany({ where });

    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        buckets: [],
        percentiles: { p25: '0', p50: '0', p75: '0', p90: '0', p99: '0' },
        avgAmount: '0',
        minAmount: '0',
        maxAmount: '0',
        outlierCount: 0,
      };
    }

    const amounts = txns.map((t: any) => Number(t.amount)).sort((a, b) => a - b);
    const total = amounts.reduce((s, a) => s + a, 0);
    const avg = total / amounts.length;

    const bucketDefs = [
      { label: 'micro', min: 0, max: 1000 },
      { label: 'small', min: 1000, max: 10000 },
      { label: 'medium', min: 10000, max: 100000 },
      { label: 'large', min: 100000, max: 1000000 },
      { label: 'very_large', min: 1000000, max: Infinity },
    ];

    const buckets = bucketDefs.map(def => {
      const inBucket = amounts.filter(a => a >= def.min && a < def.max);
      return {
        label: def.label,
        count: inBucket.length,
        share: Math.round((inBucket.length / amounts.length) * 10000) / 100,
        totalAmount: inBucket.reduce((s, a) => s + a, 0).toString(),
      };
    });

    const pctl = (p: number) => {
      const idx = Math.ceil((p / 100) * amounts.length) - 1;
      return amounts[Math.max(0, idx)].toString();
    };

    const variance = amounts.reduce((s, a) => s + (a - avg) ** 2, 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    const outlierCount = amounts.filter(a => Math.abs(a - avg) > 3 * stdDev).length;

    return {
      totalTransactions: amounts.length,
      buckets,
      percentiles: { p25: pctl(25), p50: pctl(50), p75: pctl(75), p90: pctl(90), p99: pctl(99) },
      avgAmount: Math.round(avg).toString(),
      minAmount: amounts[0].toString(),
      maxAmount: amounts[amounts.length - 1].toString(),
      outlierCount,
    };
  }

  async getPeakActivityAnalysis(userId: string) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        byHour: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, volume: '0' })),
        byDayOfWeek: [],
        peakHour: null,
        peakDay: null,
        quietestHour: null,
        weekdayVsWeekend: { weekday: 0, weekend: 0 },
      };
    }

    const hourMap = new Map<number, { count: number; volume: number }>();
    const dayMap = new Map<number, { count: number; volume: number }>();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (let h = 0; h < 24; h++) hourMap.set(h, { count: 0, volume: 0 });
    for (let d = 0; d < 7; d++) dayMap.set(d, { count: 0, volume: 0 });

    for (const txn of txns) {
      const d = new Date(txn.createdAt);
      const hour = d.getUTCHours();
      const day = d.getUTCDay();
      const amount = Math.abs(Number(txn.amount));

      const hEntry = hourMap.get(hour)!;
      hEntry.count++;
      hEntry.volume += amount;

      const dEntry = dayMap.get(day)!;
      dEntry.count++;
      dEntry.volume += amount;
    }

    const byHour = Array.from(hourMap.entries())
      .map(([hour, data]) => ({ hour, count: data.count, volume: data.volume.toString() }));

    const byDayOfWeek = Array.from(dayMap.entries())
      .map(([day, data]) => ({ day: dayNames[day]!, dayIndex: day, count: data.count, volume: data.volume.toString() }));

    let peakHour: number | null = null;
    let peakHourCount = 0;
    let quietestHour: number | null = null;
    let quietestCount = Infinity;
    for (const [hour, data] of hourMap) {
      if (data.count > peakHourCount) { peakHourCount = data.count; peakHour = hour; }
      if (data.count < quietestCount) { quietestCount = data.count; quietestHour = hour; }
    }

    let peakDay: string | null = null;
    let peakDayCount = 0;
    for (const [day, data] of dayMap) {
      if (data.count > peakDayCount) { peakDayCount = data.count; peakDay = dayNames[day]!; }
    }

    const weekday = [1, 2, 3, 4, 5].reduce((s, d) => s + (dayMap.get(d)?.count ?? 0), 0);
    const weekend = [0, 6].reduce((s, d) => s + (dayMap.get(d)?.count ?? 0), 0);

    return {
      totalTransactions: txns.length,
      byHour,
      byDayOfWeek,
      peakHour,
      peakDay,
      quietestHour,
      weekdayVsWeekend: { weekday, weekend },
    };
  }

  async getTransactionAnomalyDetection(userId: string, currency?: string) {
    const where: any = { userId };
    if (currency) where.currency = currency;
    const txns = await this.prisma.transaction.findMany({ where });

    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        anomalies: [],
        avgAmount: '0',
        stdDeviation: '0',
        threshold: '0',
      };
    }

    const amounts = txns.map((t: any) => Number(t.amount || 0));
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((sum, a) => sum + (a - avg) ** 2, 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    const threshold = avg + 2 * stdDev;

    const anomalies: { transactionId: string; amount: string; deviation: number; date: string }[] = [];
    for (const t of txns) {
      const amt = Number((t as any).amount || 0);
      if (amt > threshold) {
        anomalies.push({
          transactionId: t.id,
          amount: String((t as any).amount || 0),
          deviation: Number(((amt - avg) / (stdDev || 1)).toFixed(2)),
          date: t.createdAt.toISOString(),
        });
      }
    }

    anomalies.sort((a, b) => b.deviation - a.deviation);

    return {
      totalTransactions: txns.length,
      anomalies: anomalies.slice(0, 10),
      avgAmount: Math.round(avg).toString(),
      stdDeviation: Math.round(stdDev).toString(),
      threshold: Math.round(threshold).toString(),
    };
  }

  async getTransactionCorrelationAnalysis(userId: string, currency?: string) {
    const where: any = { userId };
    if (currency) where.currency = currency;
    const txns = await this.prisma.transaction.findMany({ where, orderBy: { createdAt: 'asc' } });

    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        typePairs: [] as { typeA: string; typeB: string; coOccurrence: number; avgGapHours: number }[],
        dominantFlow: null as string | null,
        recommendations: [] as string[],
      };
    }

    const pairMap = new Map<string, { count: number; totalGap: number }>();
    const typeCount = new Map<string, number>();

    for (let i = 0; i < txns.length; i++) {
      const typeA = ((txns[i] as any).type || 'unknown').toUpperCase();
      typeCount.set(typeA, (typeCount.get(typeA) || 0) + 1);

      if (i + 1 < txns.length) {
        const typeB = ((txns[i + 1] as any).type || 'unknown').toUpperCase();
        const key = `${typeA}->${typeB}`;
        const gap = new Date((txns[i + 1] as any).createdAt).getTime() - new Date((txns[i] as any).createdAt).getTime();
        const gapHours = gap / 3600000;

        const existing = pairMap.get(key) || { count: 0, totalGap: 0 };
        existing.count++;
        existing.totalGap += gapHours;
        pairMap.set(key, existing);
      }
    }

    const typePairs = Array.from(pairMap.entries())
      .map(([key, data]) => {
        const [typeA, typeB] = key.split('->');
        return {
          typeA: typeA!,
          typeB: typeB!,
          coOccurrence: data.count,
          avgGapHours: Number((data.totalGap / data.count).toFixed(2)),
        };
      })
      .sort((a, b) => b.coOccurrence - a.coOccurrence)
      .slice(0, 10);

    const sortedTypes = Array.from(typeCount.entries()).sort((a, b) => b[1] - a[1]);
    const dominantFlow = sortedTypes.length >= 2
      ? `${sortedTypes[0]![0]} -> ${sortedTypes[1]![0]}`
      : sortedTypes[0]?.[0] || null;

    const recommendations: string[] = [];
    if (typePairs.length > 0 && typePairs[0]!.avgGapHours < 1) {
      recommendations.push(`Frequent ${typePairs[0]!.typeA} -> ${typePairs[0]!.typeB} within 1 hour — consider bundling`);
    }
    if (sortedTypes.length === 1) recommendations.push('All transactions are the same type — limited diversification');
    if (txns.length > 100 && typePairs.length < 3) recommendations.push('Low variety in transaction flow patterns');

    return {
      totalTransactions: txns.length,
      typePairs,
      dominantFlow,
      recommendations,
    };
  }

  async getTransactionRiskProfile(userId: string) {
    const txns = await this.prisma.transaction.findMany({ where: { userId } });
    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        riskScore: 0,
        riskLevel: 'no_data',
        largeTransactions: 0,
        unusualPatterns: 0,
        recommendations: [],
      };
    }

    const amounts = txns.map(t => Number((t as any).amount ?? 0));
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const stdDev = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length);

    const largeThreshold = mean + 2 * stdDev;
    const largeTransactions = amounts.filter(a => a > largeThreshold).length;

    const types = txns.map(t => ((t as any).type || '').toUpperCase());
    const typeSet = new Set(types);
    const unusualTypes = ['REVERSAL', 'CHARGEBACK', 'DISPUTE', 'REFUND'];
    const unusualPatterns = types.filter(t => unusualTypes.includes(t)).length;

    let riskScore = 0;
    if (largeTransactions > 5) riskScore += 30;
    else if (largeTransactions > 0) riskScore += 15;
    if (unusualPatterns > 3) riskScore += 35;
    else if (unusualPatterns > 0) riskScore += 15;
    if (typeSet.size > 5) riskScore += 10;
    riskScore = Math.min(100, riskScore);

    const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'moderate' : 'low';

    const recommendations: string[] = [];
    if (largeTransactions > 0) recommendations.push(`${largeTransactions} transaction(s) significantly above average — review for fraud`);
    if (unusualPatterns > 0) recommendations.push(`${unusualPatterns} reversal/chargeback transaction(s) detected`);
    if (riskLevel === 'low') recommendations.push('Transaction patterns appear normal');

    return {
      totalTransactions: txns.length,
      riskScore,
      riskLevel,
      largeTransactions,
      unusualPatterns,
      recommendations,
    };
  }

  async getTransactionVelocityMonitor(userId: string) {
    const txns = await this.prisma.transaction.findMany({ where: { userId } });

    if (txns.length === 0) {
      return {
        totalTransactions: 0,
        velocityLevel: 'no_data' as const,
        velocityScore: 0,
        hourlyDistribution: {},
        peakHour: null,
        recommendations: [],
      };
    }

    const hourlyDistribution: Record<string, number> = {};
    const dailyMap = new Map<string, number>();

    for (const t of txns) {
      const date = new Date(t.createdAt);
      const hour = String(date.getHours()).padStart(2, '0');
      hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1;

      const dayKey = date.toISOString().slice(0, 10);
      dailyMap.set(dayKey, (dailyMap.get(dayKey) || 0) + 1);
    }

    const peakHour = Object.entries(hourlyDistribution)
      .sort((a, b) => b[1] - a[1])[0];

    const dailyCounts = Array.from(dailyMap.values());
    const avgDaily = dailyCounts.reduce((s, c) => s + c, 0) / dailyCounts.length;
    const maxDaily = Math.max(...dailyCounts);

    const burstRatio = avgDaily > 0 ? maxDaily / avgDaily : 0;

    let velocityScore = 50;
    if (burstRatio > 5) velocityScore += 40;
    else if (burstRatio > 3) velocityScore += 25;
    else if (burstRatio > 2) velocityScore += 10;

    if (Object.keys(hourlyDistribution).length <= 3) velocityScore += 10;
    velocityScore = Math.min(100, velocityScore);

    const velocityLevel = velocityScore >= 70 ? 'high' : velocityScore >= 40 ? 'moderate' : 'low';

    const recommendations: string[] = [];
    if (burstRatio > 3) recommendations.push('Transaction bursts detected — review for anomalies');
    if (Object.keys(hourlyDistribution).length <= 3) recommendations.push('Transactions concentrated in few hours');
    if (maxDaily > 50) recommendations.push('High daily transaction volume — ensure limits are adequate');

    return {
      totalTransactions: txns.length,
      velocityLevel,
      velocityScore,
      avgDailyTransactions: Math.round(avgDaily * 10) / 10,
      maxDailyTransactions: maxDaily,
      burstRatio: Math.round(burstRatio * 100) / 100,
      hourlyDistribution,
      peakHour: peakHour ? { hour: peakHour[0], count: peakHour[1] } : null,
      recommendations,
    };
  }
}
