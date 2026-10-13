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
}
