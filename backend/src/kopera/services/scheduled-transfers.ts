import type { PrismaClient } from '@prisma/client';

const INTERVAL_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  biweekly: 14 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export class ScheduledTransferService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    toUserId: string;
    currency: string;
    amount: bigint;
    frequency: string;
    description?: string;
    startDate?: Date;
  }) {
    if (params.userId === params.toUserId) throw new Error('cannot_transfer_to_self');

    const frequency = params.frequency.toLowerCase();
    if (frequency !== 'once' && !INTERVAL_MS[frequency]) throw new Error('invalid_frequency');

    const recipient = await this.prisma.user.findUnique({ where: { id: params.toUserId } });
    if (!recipient) throw new Error('recipient_not_found');

    const now = new Date();
    const nextExecution = params.startDate && params.startDate > now ? params.startDate : now;

    return this.prisma.scheduledTransfer.create({
      data: {
        userId: params.userId,
        toUserId: params.toUserId,
        currency: params.currency.toUpperCase(),
        amount: params.amount,
        frequency,
        description: params.description ?? 'Scheduled transfer',
        status: 'active',
        nextExecutionDate: nextExecution,
        lastExecutionDate: null,
        executionCount: 0,
      },
    });
  }

  async listByUser(userId: string, opts?: { status?: string }) {
    const where: Record<string, unknown> = { userId };
    if (opts?.status) where.status = opts.status;
    return this.prisma.scheduledTransfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    return this.prisma.scheduledTransfer.findUnique({ where: { id } });
  }

  async update(id: string, userId: string, data: { amount?: bigint; frequency?: string; description?: string }) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');
    if (st.userId !== userId) throw new Error('forbidden');
    if (st.status === 'cancelled' || st.status === 'completed') throw new Error('transfer_not_editable');

    const updateData: Record<string, unknown> = {};
    if (data.amount !== undefined) updateData.amount = data.amount;
    if (data.frequency !== undefined) {
      const freq = data.frequency.toLowerCase();
      if (freq !== 'once' && !INTERVAL_MS[freq]) throw new Error('invalid_frequency');
      updateData.frequency = freq;
    }
    if (data.description !== undefined) updateData.description = data.description;

    return this.prisma.scheduledTransfer.update({ where: { id }, data: updateData });
  }

  async cancel(id: string, userId: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');
    if (st.userId !== userId) throw new Error('forbidden');
    if (st.status === 'cancelled') throw new Error('already_cancelled');

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }

  async pause(id: string, userId: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');
    if (st.userId !== userId) throw new Error('forbidden');
    if (st.status !== 'active') throw new Error('not_active');

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: { status: 'paused' },
    });
  }

  async resume(id: string, userId: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');
    if (st.userId !== userId) throw new Error('forbidden');
    if (st.status !== 'paused') throw new Error('not_paused');

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: { status: 'active' },
    });
  }

  async markExecuted(id: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');

    const nextDate = st.frequency === 'once'
      ? null
      : new Date(Date.now() + (INTERVAL_MS[st.frequency] ?? 0));

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: {
        executionCount: st.executionCount + 1,
        lastExecutionDate: new Date(),
        nextExecutionDate: nextDate,
        status: st.frequency === 'once' ? 'completed' : st.status,
      },
    });
  }

  async getSummary(userId: string) {
    const all = await this.prisma.scheduledTransfer.findMany({ where: { userId } });
    const active = all.filter((s: any) => s.status === 'active');
    const paused = all.filter((s: any) => s.status === 'paused');
    const byFrequency: Record<string, number> = {};
    const totalAmountByCurrency: Record<string, bigint> = {};

    for (const s of active) {
      byFrequency[s.frequency] = (byFrequency[s.frequency] ?? 0) + 1;
      totalAmountByCurrency[s.currency] = (totalAmountByCurrency[s.currency] ?? BigInt(0)) + s.amount;
    }

    let nextUpcoming: { id: string; toUserId: string; amount: bigint; currency: string; nextExecutionDate: Date } | null = null;
    for (const s of active) {
      if (s.nextExecutionDate && (!nextUpcoming || s.nextExecutionDate < nextUpcoming.nextExecutionDate)) {
        nextUpcoming = { id: s.id, toUserId: s.toUserId, amount: s.amount, currency: s.currency, nextExecutionDate: s.nextExecutionDate };
      }
    }

    return {
      activeCount: active.length,
      pausedCount: paused.length,
      totalCount: all.length,
      byFrequency,
      totalAmountByCurrency,
      nextUpcoming,
    };
  }

  async getExecutionHistory(userId: string) {
    const all = await this.prisma.scheduledTransfer.findMany({ where: { userId } });
    let totalExecutions = 0;
    const totalAmountByCurrency: Record<string, bigint> = {};
    const transfers = all.map((s: any) => {
      totalExecutions += s.executionCount;
      const totalMoved = s.amount * BigInt(s.executionCount);
      totalAmountByCurrency[s.currency] = (totalAmountByCurrency[s.currency] ?? BigInt(0)) + totalMoved;
      return {
        id: s.id,
        toUserId: s.toUserId,
        currency: s.currency,
        amountPerExecution: s.amount,
        frequency: s.frequency,
        status: s.status,
        executionCount: s.executionCount,
        totalMoved,
        lastExecutionDate: s.lastExecutionDate,
        createdAt: s.createdAt,
      };
    });

    return { totalExecutions, totalAmountByCurrency, transfers };
  }

  async getReliabilityReport(userId: string) {
    const all = await this.prisma.scheduledTransfer.findMany({ where: { userId } });
    const active = all.filter((s: any) => s.status === 'active');
    const completed = all.filter((s: any) => s.status === 'completed');
    const cancelled = all.filter((s: any) => s.status === 'cancelled');

    let totalExecutions = 0;
    const totalCommittedByCurrency: Record<string, bigint> = {};
    const recipientFrequency: Record<string, number> = {};

    for (const s of all) {
      totalExecutions += s.executionCount;
      const moved = s.amount * BigInt(s.executionCount);
      totalCommittedByCurrency[s.currency] = (totalCommittedByCurrency[s.currency] ?? BigInt(0)) + moved;
      recipientFrequency[s.toUserId] = (recipientFrequency[s.toUserId] ?? 0) + 1;
    }

    const completionRate = all.length > 0
      ? Math.round(((completed.length + active.filter((a: any) => a.executionCount > 0).length) / all.length) * 10000) / 100
      : 0;

    const topRecipients = Object.entries(recipientFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([recipientId, count]) => ({ recipientId, count }));

    return {
      totalScheduled: all.length,
      activeCount: active.length,
      completedCount: completed.length,
      cancelledCount: cancelled.length,
      totalExecutions,
      completionRate,
      totalCommittedByCurrency,
      topRecipients,
    };
  }

  async getCostProjection(userId: string, periodDays = 90) {
    const active = await this.prisma.scheduledTransfer.findMany({
      where: { userId, status: 'active' },
    });

    const projectedByCurrency: Record<string, bigint> = {};
    const details: Array<{
      id: string;
      toUserId: string;
      currency: string;
      amount: bigint;
      frequency: string;
      executionsInPeriod: number;
      projectedCost: bigint;
    }> = [];

    for (const s of active) {
      if (s.frequency === 'once') {
        const now = new Date();
        const endDate = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
        const inPeriod = s.nextExecutionDate && s.nextExecutionDate >= now && s.nextExecutionDate <= endDate && s.executionCount === 0 ? 1 : 0;
        const cost = s.amount * BigInt(inPeriod);
        projectedByCurrency[s.currency] = (projectedByCurrency[s.currency] ?? BigInt(0)) + cost;
        details.push({
          id: s.id, toUserId: s.toUserId, currency: s.currency,
          amount: s.amount, frequency: s.frequency,
          executionsInPeriod: inPeriod, projectedCost: cost,
        });
        continue;
      }

      const intervalMs = INTERVAL_MS[s.frequency] ?? 0;
      if (intervalMs === 0) continue;
      const periodMs = periodDays * 24 * 60 * 60 * 1000;
      const executionsInPeriod = Math.floor(periodMs / intervalMs);
      const cost = s.amount * BigInt(executionsInPeriod);

      projectedByCurrency[s.currency] = (projectedByCurrency[s.currency] ?? BigInt(0)) + cost;
      details.push({
        id: s.id, toUserId: s.toUserId, currency: s.currency,
        amount: s.amount, frequency: s.frequency,
        executionsInPeriod, projectedCost: cost,
      });
    }

    return {
      periodDays,
      activeTransfers: active.length,
      projectedByCurrency,
      details,
    };
  }

  async getRecipientAnalysis(userId: string) {
    const transfers = await this.prisma.scheduledTransfer.findMany({
      where: { userId },
    });

    if (transfers.length === 0) {
      return {
        totalTransfers: 0,
        uniqueRecipients: 0,
        recipients: [] as Array<{
          toUserId: string;
          transferCount: number;
          totalAmount: string;
          currencies: string[];
          frequencies: string[];
          sharePercent: number;
        }>,
        topRecipient: null as { toUserId: string; totalAmount: string } | null,
        concentrationLevel: 'none' as string,
      };
    }

    const recipientMap = new Map<string, {
      count: number;
      totalAmount: bigint;
      currencies: Set<string>;
      frequencies: Set<string>;
    }>();

    let grandTotal = BigInt(0);

    for (const t of transfers) {
      const entry = recipientMap.get(t.toUserId) ?? {
        count: 0,
        totalAmount: BigInt(0),
        currencies: new Set<string>(),
        frequencies: new Set<string>(),
      };
      entry.count++;
      entry.totalAmount += t.amount;
      entry.currencies.add(t.currency);
      entry.frequencies.add(t.frequency);
      grandTotal += t.amount;
      recipientMap.set(t.toUserId, entry);
    }

    const recipients = Array.from(recipientMap.entries())
      .map(([toUserId, data]) => ({
        toUserId,
        transferCount: data.count,
        totalAmount: data.totalAmount.toString(),
        currencies: Array.from(data.currencies),
        frequencies: Array.from(data.frequencies),
        sharePercent: grandTotal > BigInt(0)
          ? Math.round(Number(data.totalAmount * BigInt(10000) / grandTotal)) / 100
          : 0,
      }))
      .sort((a, b) => Number(BigInt(b.totalAmount) - BigInt(a.totalAmount)));

    const topRecipient = recipients.length > 0
      ? { toUserId: recipients[0]!.toUserId, totalAmount: recipients[0]!.totalAmount }
      : null;

    const topShare = recipients.length > 0 ? recipients[0]!.sharePercent : 0;
    let concentrationLevel: string;
    if (topShare > 80) concentrationLevel = 'high';
    else if (topShare > 50) concentrationLevel = 'moderate';
    else if (recipients.length > 0) concentrationLevel = 'low';
    else concentrationLevel = 'none';

    return {
      totalTransfers: transfers.length,
      uniqueRecipients: recipientMap.size,
      recipients,
      topRecipient,
      concentrationLevel,
    };
  }

  async processDueTransfers() {
    const now = new Date();
    const due = await this.prisma.scheduledTransfer.findMany({
      where: { status: 'active', nextExecutionDate: { lte: now } },
    });

    const results: Array<{ transferId: string; success: boolean; reason?: string }> = [];

    for (const st of due) {
      const senderWallet = await this.prisma.wallet.findFirst({
        where: { userId: st.userId, currency: st.currency, status: 'ACTIVE' },
      });

      if (!senderWallet || senderWallet.balance < st.amount) {
        results.push({ transferId: st.id, success: false, reason: 'insufficient_funds' });
        continue;
      }

      let receiverWallet = await this.prisma.wallet.findFirst({
        where: { userId: st.toUserId, currency: st.currency, status: 'ACTIVE' },
      });

      if (!receiverWallet) {
        receiverWallet = await this.prisma.wallet.create({
          data: {
            userId: st.toUserId,
            currency: st.currency,
            balance: BigInt(0),
            status: 'ACTIVE',
            isDefault: false,
          },
        });
      }

      await this.prisma.wallet.update({
        where: { id: senderWallet.id },
        data: { balance: senderWallet.balance - st.amount },
      });

      await this.prisma.wallet.update({
        where: { id: receiverWallet.id },
        data: { balance: receiverWallet.balance + st.amount },
      });

      await this.markExecuted(st.id);

      results.push({ transferId: st.id, success: true });
    }

    return { processed: results.length, results };
  }

  async getFrequencyOptimization(userId: string) {
    const transfers = await this.prisma.scheduledTransfer.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (transfers.length === 0) {
      return {
        totalTransfers: 0,
        activeTransfers: 0,
        consolidationOpportunities: [],
        inactiveButScheduled: [],
        suggestions: [],
      };
    }

    const active = transfers.filter((t: any) => t.status === 'active');

    const recipientMap = new Map<string, any[]>();
    for (const t of active) {
      const key = `${(t as any).toUserId}_${t.currency}`;
      const arr = recipientMap.get(key) ?? [];
      arr.push(t);
      recipientMap.set(key, arr);
    }

    const consolidationOpportunities: any[] = [];
    for (const [, group] of recipientMap) {
      if (group.length > 1) {
        const totalMonthly = group.reduce((s: bigint, t: any) => {
          const freq = t.frequency;
          const multiplier = freq === 'daily' ? 30 : freq === 'weekly' ? 4 : freq === 'biweekly' ? 2 : 1;
          return s + t.amount * BigInt(multiplier);
        }, BigInt(0));
        consolidationOpportunities.push({
          recipientId: (group[0] as any).toUserId,
          currency: group[0].currency,
          transferCount: group.length,
          frequencies: group.map((t: any) => t.frequency),
          combinedMonthlyAmount: totalMonthly.toString(),
          transferIds: group.map((t: any) => t.id),
        });
      }
    }

    const inactiveButScheduled = active.filter((t: any) => {
      return t.executionCount === 0 &&
        new Date(t.createdAt).getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000;
    }).map((t: any) => ({
      id: t.id,
      toUserId: t.toUserId,
      amount: t.amount.toString(),
      currency: t.currency,
      frequency: t.frequency,
      daysSinceCreated: Math.round((Date.now() - new Date(t.createdAt).getTime()) / (24 * 60 * 60 * 1000)),
    }));

    const suggestions: string[] = [];
    if (consolidationOpportunities.length > 0) {
      suggestions.push(`${consolidationOpportunities.length} recipient(s) have multiple scheduled transfers that could be consolidated`);
    }
    if (inactiveButScheduled.length > 0) {
      suggestions.push(`${inactiveButScheduled.length} transfer(s) are scheduled but have never executed`);
    }
    const dailyTransfers = active.filter((t: any) => t.frequency === 'daily');
    if (dailyTransfers.length > 0) {
      suggestions.push(`${dailyTransfers.length} daily transfer(s) could potentially be batched to weekly`);
    }

    return {
      totalTransfers: transfers.length,
      activeTransfers: active.length,
      consolidationOpportunities,
      inactiveButScheduled,
      suggestions,
    };
  }

  async getExecutionSuccessRate(userId: string) {
    const transfers = await this.prisma.scheduledTransfer.findMany({
      where: { userId },
    });

    if (transfers.length === 0) {
      return {
        totalTransfers: 0,
        totalExecutions: 0,
        successRate: 0,
        avgExecutionsPerTransfer: 0,
        byFrequency: [] as Array<{ frequency: string; transfers: number; totalExecutions: number; avgExecutions: number }>,
        mostReliable: null as string | null,
        leastReliable: null as string | null,
      };
    }

    let totalExecutions = 0;
    const freqMap = new Map<string, { transfers: number; totalExecutions: number }>();

    for (const t of transfers) {
      const execCount = (t as any).executionCount ?? 0;
      totalExecutions += execCount;

      const freq = (t as any).frequency ?? 'unknown';
      const entry = freqMap.get(freq) ?? { transfers: 0, totalExecutions: 0 };
      entry.transfers++;
      entry.totalExecutions += execCount;
      freqMap.set(freq, entry);
    }

    const withExecutions = transfers.filter((t: any) => (t.executionCount ?? 0) > 0).length;
    const successRate = transfers.length > 0
      ? Math.round((withExecutions / transfers.length) * 10000) / 100
      : 0;
    const avgExecutionsPerTransfer = transfers.length > 0
      ? Math.round((totalExecutions / transfers.length) * 100) / 100
      : 0;

    const byFrequency = Array.from(freqMap.entries())
      .map(([frequency, data]) => ({
        frequency,
        transfers: data.transfers,
        totalExecutions: data.totalExecutions,
        avgExecutions: data.transfers > 0
          ? Math.round((data.totalExecutions / data.transfers) * 100) / 100
          : 0,
      }))
      .sort((a, b) => b.avgExecutions - a.avgExecutions);

    return {
      totalTransfers: transfers.length,
      totalExecutions,
      successRate,
      avgExecutionsPerTransfer,
      byFrequency,
      mostReliable: byFrequency[0]?.frequency ?? null,
      leastReliable: byFrequency.length > 1 ? byFrequency[byFrequency.length - 1].frequency : null,
    };
  }

  async getScheduleConflictAnalysis(userId: string) {
    const transfers = await this.prisma.scheduledTransfer.findMany({
      where: { userId, status: { in: ['active', 'paused'] } },
    });

    if (transfers.length === 0) {
      return {
        totalActiveSchedules: 0,
        conflictDays: [],
        concentrationRisk: 'none' as const,
        avgTransfersPerDay: 0,
        peakDay: null,
        recommendations: [],
      };
    }

    const dayMap = new Map<number, string[]>();
    for (const t of transfers) {
      if (!t.nextExecutionDate) continue;
      const dayOfMonth = new Date(t.nextExecutionDate).getDate();
      const existing = dayMap.get(dayOfMonth) ?? [];
      existing.push(t.id);
      dayMap.set(dayOfMonth, existing);
    }

    const conflictDays = Array.from(dayMap.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([day, ids]) => ({ day, count: ids.length }))
      .sort((a, b) => b.count - a.count);

    const totalDaysUsed = dayMap.size;
    const avgTransfersPerDay = totalDaysUsed > 0
      ? Math.round((transfers.filter((t) => t.nextExecutionDate).length / totalDaysUsed) * 10) / 10
      : 0;

    let peakDay: number | null = null;
    let peakCount = 0;
    for (const [day, ids] of dayMap) {
      if (ids.length > peakCount) {
        peakCount = ids.length;
        peakDay = day;
      }
    }

    const totalWithDate = transfers.filter((t) => t.nextExecutionDate).length;
    const maxOnOneDay = peakCount;
    const concentrationRatio = totalWithDate > 0 ? maxOnOneDay / totalWithDate : 0;
    const concentrationRisk = concentrationRatio > 0.5 ? 'high' as const
      : concentrationRatio > 0.3 ? 'medium' as const
      : conflictDays.length > 0 ? 'low' as const
      : 'none' as const;

    const recommendations: string[] = [];
    if (concentrationRisk === 'high') {
      recommendations.push('Spread transfers across different days to reduce liquidity pressure');
    }
    if (conflictDays.length > 0) {
      recommendations.push(`${conflictDays.length} day(s) have multiple transfers scheduled`);
    }

    const amountByDay = new Map<number, bigint>();
    for (const t of transfers) {
      if (!t.nextExecutionDate) continue;
      const day = new Date(t.nextExecutionDate).getDate();
      amountByDay.set(day, (amountByDay.get(day) ?? BigInt(0)) + (t.amount ?? BigInt(0)));
    }
    const highestAmountDay = Array.from(amountByDay.entries())
      .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))[0];
    if (highestAmountDay && highestAmountDay[1] > BigInt(0)) {
      recommendations.push(`Day ${highestAmountDay[0]} has the highest total amount: ${highestAmountDay[1].toString()}`);
    }

    return {
      totalActiveSchedules: transfers.length,
      conflictDays,
      concentrationRisk,
      avgTransfersPerDay,
      peakDay,
      recommendations,
    };
  }

  async getTransferCurrencyExposure(userId: string) {
    const transfers = await this.prisma.scheduledTransfer.findMany({
      where: { userId, status: 'active' },
    });

    if (transfers.length === 0) {
      return {
        totalActiveTransfers: 0,
        currencies: [],
        diversificationScore: 0,
        totalMonthlyVolume: '0',
        dominantCurrency: null,
      };
    }

    const currencyMap = new Map<string, { count: number; volume: bigint }>();
    for (const t of transfers) {
      const currency = (t as any).currency || 'USD';
      const entry = currencyMap.get(currency) || { count: 0, volume: BigInt(0) };
      entry.count++;
      entry.volume += BigInt((t as any).amount || 0);
      currencyMap.set(currency, entry);
    }

    let totalVolume = BigInt(0);
    const currencies: { currency: string; count: number; volume: string; share: number }[] = [];

    for (const [currency, data] of currencyMap) {
      totalVolume += data.volume;
      currencies.push({
        currency,
        count: data.count,
        volume: data.volume.toString(),
        share: 0,
      });
    }

    for (const c of currencies) {
      c.share = totalVolume > 0
        ? Number((BigInt(c.volume) * BigInt(10000) / totalVolume)) / 100
        : 0;
    }

    currencies.sort((a, b) => b.share - a.share);

    const shares = currencies.map(c => c.share / 100);
    const hhi = shares.reduce((sum, s) => sum + s * s, 0);
    const diversificationScore = currencies.length > 1
      ? Number(((1 - hhi) * 100).toFixed(2))
      : 0;

    return {
      totalActiveTransfers: transfers.length,
      currencies,
      diversificationScore,
      totalMonthlyVolume: totalVolume.toString(),
      dominantCurrency: currencies[0]?.currency || null,
    };
  }

  async getTransferLoadDistribution(userId: string) {
    const transfers = await this.prisma.scheduledTransfer.findMany({
      where: { userId },
    });

    if (transfers.length === 0) {
      return {
        totalTransfers: 0,
        byDayOfWeek: {} as Record<string, number>,
        byFrequency: {} as Record<string, number>,
        peakDay: null as string | null,
        loadBalance: 0,
        recommendations: [] as string[],
      };
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayCount: Record<string, number> = {};
    const freqCount: Record<string, number> = {};

    for (const t of transfers) {
      const freq = ((t as any).frequency || 'unknown').toLowerCase();
      freqCount[freq] = (freqCount[freq] || 0) + 1;

      const nextExec = (t as any).nextExecutionDate || (t as any).nextDate || t.createdAt;
      if (nextExec) {
        const day = dayNames[new Date(nextExec).getDay()] || 'Unknown';
        dayCount[day] = (dayCount[day] || 0) + 1;
      }
    }

    let peakDay: string | null = null;
    let peakCount = 0;
    for (const [day, count] of Object.entries(dayCount)) {
      if (count > peakCount) {
        peakCount = count;
        peakDay = day;
      }
    }

    const dayValues = Object.values(dayCount);
    const avgPerDay = dayValues.length > 0
      ? dayValues.reduce((a, b) => a + b, 0) / dayValues.length
      : 0;
    const maxDay = Math.max(...dayValues, 0);
    const loadBalance = maxDay > 0
      ? Number(((1 - (maxDay - avgPerDay) / maxDay) * 100).toFixed(2))
      : 100;

    const recommendations: string[] = [];
    if (loadBalance < 50) recommendations.push('Transfers are heavily concentrated on specific days — consider spreading them out');
    if (peakCount > transfers.length * 0.5) recommendations.push(`Over half of transfers execute on ${peakDay} — redistribute for better cash flow management`);
    if (Object.keys(freqCount).length === 1) recommendations.push('All transfers use the same frequency — consider varying based on payment importance');

    return {
      totalTransfers: transfers.length,
      byDayOfWeek: dayCount,
      byFrequency: freqCount,
      peakDay,
      loadBalance,
      recommendations,
    };
  }

  async getTransferReliabilityIndex(userId: string) {
    const transfers = await this.prisma.scheduledTransfer.findMany({ where: { userId } });
    if (transfers.length === 0) {
      return {
        totalTransfers: 0,
        reliabilityIndex: 100,
        reliabilityLevel: 'no_data',
        successRate: 0,
        failureRate: 0,
        cancelledRate: 0,
        recommendations: [],
      };
    }

    let successCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    let activeCount = 0;

    for (const t of transfers) {
      const status = ((t as any).status || '').toLowerCase();
      if (status === 'completed' || status === 'executed') successCount++;
      else if (status === 'failed') failedCount++;
      else if (status === 'cancelled') cancelledCount++;
      else if (status === 'active' || status === 'scheduled' || status === 'pending') activeCount++;
    }

    const completed = successCount + failedCount;
    const successRate = completed > 0 ? Math.round((successCount / completed) * 10000) / 100 : 100;
    const failureRate = completed > 0 ? Math.round((failedCount / completed) * 10000) / 100 : 0;
    const cancelledRate = transfers.length > 0 ? Math.round((cancelledCount / transfers.length) * 10000) / 100 : 0;

    let reliabilityIndex = 100;
    if (failureRate > 20) reliabilityIndex -= 40;
    else if (failureRate > 5) reliabilityIndex -= 20;
    if (cancelledRate > 30) reliabilityIndex -= 20;
    else if (cancelledRate > 10) reliabilityIndex -= 10;
    reliabilityIndex = Math.max(0, reliabilityIndex);

    const reliabilityLevel = reliabilityIndex >= 80 ? 'excellent'
      : reliabilityIndex >= 50 ? 'fair' : 'poor';

    const recommendations: string[] = [];
    if (failedCount > 0) recommendations.push('Review failed transfers for insufficient funds or invalid recipients');
    if (cancelledRate > 20) recommendations.push('High cancellation rate — review if schedules match your needs');
    if (activeCount > 10) recommendations.push('Many active transfers — review for duplicates or outdated schedules');

    return {
      totalTransfers: transfers.length,
      reliabilityIndex,
      reliabilityLevel,
      successRate,
      failureRate,
      cancelledRate,
      activeCount,
      recommendations,
    };
  }
}
