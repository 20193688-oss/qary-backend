import type { PrismaClient } from '@prisma/client';

export class LoanRepaymentService {
  constructor(private prisma: PrismaClient) {}

  async listByLoan(loanId: string) {
    return this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });
  }

  async getById(id: string) {
    return this.prisma.loanRepayment.findUnique({ where: { id } });
  }

  async makePayment(id: string, amount: bigint) {
    const repayment = await this.prisma.loanRepayment.findUnique({ where: { id } });
    if (!repayment) throw new Error('repayment_not_found');
    if (repayment.status === 'PAID') throw new Error('already_paid');

    const newPaid = repayment.paidAmount + amount;
    const isPaid = newPaid >= repayment.amount;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.loanRepayment.update({
        where: { id },
        data: {
          paidAmount: newPaid,
          paidAt: isPaid ? new Date() : null,
          status: isPaid ? 'PAID' : 'PARTIAL',
        },
      });

      if (isPaid) {
        const loan = await tx.loan.findUnique({ where: { id: repayment.loanId } });
        if (loan && loan.outstandingBalance !== null) {
          const newBalance = loan.outstandingBalance - repayment.amount;
          const nextRepayment = await tx.loanRepayment.findFirst({
            where: { loanId: repayment.loanId, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
            orderBy: { installment: 'asc' },
          });

          await tx.loan.update({
            where: { id: repayment.loanId },
            data: {
              outstandingBalance: newBalance > BigInt(0) ? newBalance : BigInt(0),
              nextPaymentDate: nextRepayment?.dueDate ?? null,
              nextPaymentAmount: nextRepayment?.amount ?? null,
              ...(newBalance <= BigInt(0) ? { status: 'PAID_OFF' } : {}),
            },
          });
        }
      }

      return updated;
    });
  }

  async markOverdue(id: string) {
    const repayment = await this.prisma.loanRepayment.findUnique({ where: { id } });
    if (!repayment) throw new Error('repayment_not_found');
    if (repayment.status === 'PAID') throw new Error('already_paid');

    return this.prisma.loanRepayment.update({
      where: { id },
      data: { status: 'OVERDUE' },
    });
  }

  async processDueRepayments() {
    const now = new Date();
    const due = await this.prisma.loanRepayment.findMany({
      where: { status: 'PENDING', dueDate: { lte: now } },
    });

    const results: Array<{ repaymentId: string; success: boolean; reason?: string }> = [];

    for (const rep of due) {
      const loan = await this.prisma.loan.findUnique({ where: { id: rep.loanId } });
      if (!loan) {
        results.push({ repaymentId: rep.id, success: false, reason: 'loan_not_found' });
        continue;
      }

      const wallet = await this.prisma.wallet.findFirst({
        where: { userId: loan.userId, currency: loan.currency, status: 'ACTIVE' },
      });

      if (!wallet || wallet.balance < rep.amount) {
        await this.prisma.loanRepayment.update({
          where: { id: rep.id },
          data: { status: 'OVERDUE' },
        });
        const currentMissed = (loan as any).missedPayments ?? 0;
        await this.prisma.loan.update({
          where: { id: loan.id },
          data: { missedPayments: currentMissed + 1 },
        });
        results.push({ repaymentId: rep.id, success: false, reason: 'insufficient_funds' });
        continue;
      }

      await this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: wallet.balance - rep.amount },
      });

      await this.makePayment(rep.id, rep.amount);
      results.push({ repaymentId: rep.id, success: true });
    }

    return { processed: results.length, results };
  }

  async calculateEarlyPayoff(loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new Error('loan_not_found');
    if (loan.status !== 'DISBURSED') throw new Error('loan_not_active');

    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    let remainingPrincipal = BigInt(0);
    let savedInterest = BigInt(0);
    let remainingInstallments = 0;

    for (const r of repayments) {
      if (r.status !== 'PAID') {
        remainingPrincipal += r.principal;
        savedInterest += r.interest;
        remainingInstallments++;
      }
    }

    return {
      loanId,
      payoffAmount: remainingPrincipal,
      savedInterest,
      remainingInstallments,
      originalTermMonths: loan.termMonths,
    };
  }

  async getPaymentHistory(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    let totalPaid = BigInt(0);
    let totalOwed = BigInt(0);
    let onTimeCount = 0;
    let lateCount = 0;
    const payments: Array<{ installment: number; amount: bigint; paidAmount: bigint; dueDate: Date; paidAt: Date | null; status: string }> = [];

    for (const r of repayments) {
      totalOwed += r.amount;
      totalPaid += r.paidAmount;
      if (r.status === 'PAID') {
        if (r.paidAt && r.dueDate && r.paidAt <= r.dueDate) onTimeCount++;
        else lateCount++;
      } else if (r.status === 'OVERDUE') {
        lateCount++;
      }
      payments.push({
        installment: r.installment,
        amount: r.amount,
        paidAmount: r.paidAmount,
        dueDate: r.dueDate,
        paidAt: r.paidAt,
        status: r.status,
      });
    }

    return {
      loanId,
      totalInstallments: repayments.length,
      totalOwed,
      totalPaid,
      remaining: totalOwed - totalPaid,
      onTimePayments: onTimeCount,
      latePayments: lateCount,
      payments,
    };
  }

  async getDelinquencyReport(loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new Error('loan_not_found');

    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    let overdueCount = 0;
    let overdueAmount = BigInt(0);
    let consecutiveOverdue = 0;
    let maxConsecutiveOverdue = 0;
    let currentStreak = 0;
    const overdueInstallments: Array<{ installment: number; dueDate: Date; amount: bigint; paidAmount: bigint }> = [];

    for (const r of repayments) {
      if (r.status === 'OVERDUE') {
        overdueCount++;
        overdueAmount += r.amount - r.paidAmount;
        currentStreak++;
        if (currentStreak > maxConsecutiveOverdue) maxConsecutiveOverdue = currentStreak;
        overdueInstallments.push({ installment: r.installment, dueDate: r.dueDate, amount: r.amount, paidAmount: r.paidAmount });
      } else {
        currentStreak = 0;
      }
    }
    consecutiveOverdue = currentStreak;

    const delinquencyRate = repayments.length > 0 ? Math.round((overdueCount / repayments.length) * 10000) / 100 : 0;
    const severity = consecutiveOverdue >= 3 ? 'critical' : overdueCount > 0 ? 'warning' : 'ok';

    return {
      loanId,
      totalInstallments: repayments.length,
      overdueCount,
      overdueAmount,
      consecutiveOverdue,
      maxConsecutiveOverdue,
      delinquencyRate,
      severity,
      overdueInstallments,
    };
  }

  async getAmortizationAnalysis(loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new Error('loan_not_found');

    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    let totalPrincipal = BigInt(0);
    let totalInterest = BigInt(0);
    let cumulativePrincipal = BigInt(0);
    let cumulativeInterest = BigInt(0);
    let principalPaidSoFar = BigInt(0);
    let interestPaidSoFar = BigInt(0);

    const schedule: Array<{
      installment: number;
      principal: bigint;
      interest: bigint;
      total: bigint;
      cumulativePrincipal: bigint;
      cumulativeInterest: bigint;
      status: string;
    }> = [];

    for (const r of repayments) {
      totalPrincipal += r.principal;
      totalInterest += r.interest;
      cumulativePrincipal += r.principal;
      cumulativeInterest += r.interest;

      if (r.status === 'PAID') {
        principalPaidSoFar += r.principal;
        interestPaidSoFar += r.interest;
      }

      schedule.push({
        installment: r.installment,
        principal: r.principal,
        interest: r.interest,
        total: r.amount,
        cumulativePrincipal,
        cumulativeInterest,
        status: r.status,
      });
    }

    const interestToTotalRatio = totalPrincipal > BigInt(0)
      ? Math.round(Number(totalInterest) / Number(totalPrincipal + totalInterest) * 10000) / 100
      : 0;

    const progressPercent = totalPrincipal > BigInt(0)
      ? Math.round(Number(principalPaidSoFar) / Number(totalPrincipal) * 10000) / 100
      : 0;

    return {
      loanId,
      totalInstallments: repayments.length,
      totalPrincipal,
      totalInterest,
      totalCost: totalPrincipal + totalInterest,
      principalPaidSoFar,
      interestPaidSoFar,
      principalRemaining: totalPrincipal - principalPaidSoFar,
      interestRemaining: totalInterest - interestPaidSoFar,
      interestToTotalRatio,
      progressPercent,
      schedule,
    };
  }

  async getPaymentPunctuality(loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new Error('loan_not_found');

    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    let onTimeCount = 0;
    let earlyCount = 0;
    let lateCount = 0;
    let totalLateDays = 0;
    let totalEarlyDays = 0;
    let paidCount = 0;
    const latePayments: Array<{ installment: number; daysPastDue: number }> = [];

    for (const r of repayments) {
      if (r.status !== 'PAID' || !r.paidAt) continue;
      paidCount++;

      const dueTime = new Date(r.dueDate).getTime();
      const paidTime = new Date(r.paidAt).getTime();
      const diffDays = Math.round((paidTime - dueTime) / (24 * 60 * 60 * 1000));

      if (diffDays > 0) {
        lateCount++;
        totalLateDays += diffDays;
        latePayments.push({ installment: r.installment, daysPastDue: diffDays });
      } else if (diffDays < -1) {
        earlyCount++;
        totalEarlyDays += Math.abs(diffDays);
      } else {
        onTimeCount++;
      }
    }

    const punctualityScore = paidCount > 0
      ? Math.round(((onTimeCount + earlyCount) / paidCount) * 10000) / 100
      : 0;
    const avgLateDays = lateCount > 0 ? Math.round((totalLateDays / lateCount) * 100) / 100 : 0;
    const avgEarlyDays = earlyCount > 0 ? Math.round((totalEarlyDays / earlyCount) * 100) / 100 : 0;

    let rating: string;
    if (punctualityScore >= 95) rating = 'excellent';
    else if (punctualityScore >= 80) rating = 'good';
    else if (punctualityScore >= 60) rating = 'fair';
    else if (paidCount > 0) rating = 'poor';
    else rating = 'no_data';

    return {
      loanId,
      totalInstallments: repayments.length,
      paidInstallments: paidCount,
      onTimeCount,
      earlyCount,
      lateCount,
      punctualityScore,
      avgLateDays,
      avgEarlyDays,
      rating,
      latePayments,
    };
  }

  async getPartialPaymentAnalysis(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    if (repayments.length === 0) {
      return {
        loanId,
        totalInstallments: 0,
        partialPayments: 0,
        fullPayments: 0,
        unpaidCount: 0,
        avgPartialRatio: 0,
        cumulativeShortfall: '0',
        trend: 'none' as string,
        installments: [] as Array<{ installment: number; amount: string; paidAmount: string; ratio: number; isPartial: boolean }>,
      };
    }

    let partialPayments = 0;
    let fullPayments = 0;
    let unpaidCount = 0;
    let cumulativeShortfall = BigInt(0);
    const ratios: number[] = [];
    const installments: Array<{ installment: number; amount: string; paidAmount: string; ratio: number; isPartial: boolean }> = [];

    for (const r of repayments) {
      const ratio = r.amount > BigInt(0) ? Math.round((Number(r.paidAmount) / Number(r.amount)) * 10000) / 100 : 0;
      const isPartial = r.paidAmount > BigInt(0) && r.paidAmount < r.amount;

      if (r.paidAmount === BigInt(0)) unpaidCount++;
      else if (isPartial) partialPayments++;
      else fullPayments++;

      if (r.amount > r.paidAmount) cumulativeShortfall += r.amount - r.paidAmount;
      if (r.paidAmount > BigInt(0)) ratios.push(ratio);

      installments.push({
        installment: r.installment,
        amount: r.amount.toString(),
        paidAmount: r.paidAmount.toString(),
        ratio,
        isPartial,
      });
    }

    const avgPartialRatio = ratios.length > 0
      ? Math.round((ratios.reduce((s, r) => s + r, 0) / ratios.length) * 100) / 100
      : 0;

    let trend = 'none';
    if (ratios.length >= 2) {
      const half = Math.floor(ratios.length / 2);
      const firstAvg = ratios.slice(0, half).reduce((s, r) => s + r, 0) / half;
      const secondAvg = ratios.slice(half).reduce((s, r) => s + r, 0) / (ratios.length - half);
      trend = secondAvg > firstAvg + 5 ? 'improving' : secondAvg < firstAvg - 5 ? 'deteriorating' : 'stable';
    }

    return {
      loanId,
      totalInstallments: repayments.length,
      partialPayments,
      fullPayments,
      unpaidCount,
      avgPartialRatio,
      cumulativeShortfall: cumulativeShortfall.toString(),
      trend,
      installments,
    };
  }

  async getScheduleSummary(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    let totalPaid = BigInt(0);
    let totalDue = BigInt(0);
    let paidCount = 0;
    let overdueCount = 0;

    for (const r of repayments) {
      totalDue += r.amount;
      totalPaid += r.paidAmount;
      if (r.status === 'PAID') paidCount++;
      if (r.status === 'OVERDUE') overdueCount++;
    }

    return {
      loanId,
      totalInstallments: repayments.length,
      paidCount,
      overdueCount,
      pendingCount: repayments.length - paidCount,
      totalDue,
      totalPaid,
      remaining: totalDue - totalPaid,
    };
  }

  async getPaymentGapAnalysis(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId, status: 'PAID' },
      orderBy: { installment: 'asc' },
    });

    if (repayments.length < 2) {
      return {
        loanId,
        paidInstallments: repayments.length,
        gaps: [] as Array<{ fromInstallment: number; toInstallment: number; gapDays: number }>,
        avgGapDays: 0,
        medianGapDays: 0,
        maxGapDays: 0,
        irregularGaps: 0,
        pattern: 'insufficient_data' as const,
      };
    }

    const gaps: Array<{ fromInstallment: number; toInstallment: number; gapDays: number }> = [];
    for (let i = 1; i < repayments.length; i++) {
      const prev = repayments[i - 1];
      const curr = repayments[i];
      if (!prev.paidAt || !curr.paidAt) continue;
      const gapMs = new Date(curr.paidAt).getTime() - new Date(prev.paidAt).getTime();
      const gapDays = Math.round(gapMs / (24 * 60 * 60 * 1000));
      gaps.push({
        fromInstallment: prev.installment,
        toInstallment: curr.installment,
        gapDays,
      });
    }

    if (gaps.length === 0) {
      return {
        loanId,
        paidInstallments: repayments.length,
        gaps: [],
        avgGapDays: 0,
        medianGapDays: 0,
        maxGapDays: 0,
        irregularGaps: 0,
        pattern: 'insufficient_data' as const,
      };
    }

    const gapDays = gaps.map(g => g.gapDays);
    const avgGapDays = Math.round((gapDays.reduce((s, d) => s + d, 0) / gapDays.length) * 100) / 100;
    const sorted = [...gapDays].sort((a, b) => a - b);
    const medianGapDays = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    const maxGapDays = Math.max(...gapDays);

    const irregularThreshold = avgGapDays * 1.5;
    const irregularGaps = gapDays.filter(d => d > irregularThreshold).length;

    const stdDev = Math.sqrt(gapDays.reduce((s, d) => s + (d - avgGapDays) ** 2, 0) / gapDays.length);
    const cv = avgGapDays > 0 ? stdDev / avgGapDays : 0;
    const pattern = cv < 0.2 ? 'regular' as const
      : cv < 0.5 ? 'mostly_regular' as const
      : 'irregular' as const;

    return {
      loanId,
      paidInstallments: repayments.length,
      gaps,
      avgGapDays,
      medianGapDays,
      maxGapDays,
      irregularGaps,
      pattern,
    };
  }

  async getRepaymentStreakAnalysis(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    if (repayments.length === 0) {
      return {
        loanId,
        totalInstallments: 0,
        onTimeCount: 0,
        lateCount: 0,
        currentStreak: 0,
        longestStreak: 0,
        streakType: 'none' as const,
        onTimeRate: 0,
        reliability: 'unknown' as const,
      };
    }

    let currentStreak = 0;
    let longestStreak = 0;
    let currentStreakType: 'on_time' | 'late' | 'none' = 'none';
    let onTimeCount = 0;
    let lateCount = 0;

    for (const r of repayments) {
      if (r.status !== 'PAID') continue;

      const isOnTime = r.paidAt && r.dueDate
        ? new Date(r.paidAt).getTime() <= new Date(r.dueDate).getTime()
        : r.status === 'PAID';

      if (isOnTime) {
        onTimeCount++;
        if (currentStreakType === 'on_time') {
          currentStreak++;
        } else {
          currentStreak = 1;
          currentStreakType = 'on_time';
        }
      } else {
        lateCount++;
        if (currentStreakType === 'late') {
          currentStreak++;
        } else {
          currentStreak = 1;
          currentStreakType = 'late';
        }
      }

      if (currentStreakType === 'on_time' && currentStreak > longestStreak) {
        longestStreak = currentStreak;
      }
    }

    const paidCount = onTimeCount + lateCount;
    const onTimeRate = paidCount > 0
      ? Math.round((onTimeCount / paidCount) * 10000) / 100
      : 0;

    const reliability = onTimeRate >= 90 ? 'excellent' as const
      : onTimeRate >= 70 ? 'good' as const
      : onTimeRate >= 50 ? 'fair' as const
      : paidCount > 0 ? 'poor' as const
      : 'unknown' as const;

    return {
      loanId,
      totalInstallments: repayments.length,
      onTimeCount,
      lateCount,
      currentStreak,
      longestStreak,
      streakType: currentStreakType,
      onTimeRate,
      reliability,
    };
  }

  async getRepaymentProjection(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { createdAt: 'asc' },
    });

    if (repayments.length === 0) {
      return {
        loanId,
        totalRepayments: 0,
        totalPaid: '0',
        avgPaymentAmount: '0',
        projectedMonthlyPayment: '0',
        paymentConsistency: 0,
        recentPayments: [],
      };
    }

    let totalPaid = BigInt(0);
    const amounts: bigint[] = [];

    for (const r of repayments) {
      const amount = (r as any).amount ?? BigInt(0);
      totalPaid += amount;
      amounts.push(amount);
    }

    const avgAmount = totalPaid / BigInt(amounts.length);

    const gaps: number[] = [];
    for (let i = 1; i < repayments.length; i++) {
      const gap = (new Date(repayments[i].createdAt).getTime() - new Date(repayments[i - 1].createdAt).getTime()) / 86400000;
      gaps.push(gap);
    }
    const avgGap = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 30;

    const monthlyMultiplier = avgGap > 0 ? 30 / avgGap : 1;
    const projectedMonthly = BigInt(Math.round(Number(avgAmount) * monthlyMultiplier));

    const amountNumbers = amounts.map(a => Number(a));
    const mean = amountNumbers.reduce((s, a) => s + a, 0) / amountNumbers.length;
    const variance = amountNumbers.reduce((s, a) => s + (a - mean) ** 2, 0) / amountNumbers.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const consistency = Math.max(0, Math.round((1 - cv) * 100));

    const recentPayments = repayments.slice(-5).map(r => ({
      id: r.id,
      amount: ((r as any).amount ?? BigInt(0)).toString(),
      date: r.createdAt,
      status: (r as any).status || 'completed',
    }));

    return {
      loanId,
      totalRepayments: repayments.length,
      totalPaid: totalPaid.toString(),
      avgPaymentAmount: avgAmount.toString(),
      projectedMonthlyPayment: projectedMonthly.toString(),
      paymentConsistency: consistency,
      recentPayments,
    };
  }

  async getRepaymentRiskProfile(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { dueDate: 'asc' },
    });

    if (repayments.length === 0) {
      return {
        loanId,
        totalRepayments: 0,
        riskScore: 0,
        riskLevel: 'none' as const,
        lateCount: 0,
        onTimeCount: 0,
        missedCount: 0,
      };
    }

    let lateCount = 0;
    let onTimeCount = 0;
    let missedCount = 0;

    for (const r of repayments) {
      const status = ((r as any).status || '').toLowerCase();
      if (status === 'overdue' || status === 'missed') {
        missedCount++;
      } else if (status === 'late') {
        lateCount++;
      } else if (status === 'paid' || status === 'completed') {
        if ((r as any).paidAt && (r as any).dueDate) {
          const paid = new Date((r as any).paidAt).getTime();
          const due = new Date((r as any).dueDate).getTime();
          if (paid > due) lateCount++;
          else onTimeCount++;
        } else {
          onTimeCount++;
        }
      }
    }

    let riskScore = 0;
    const lateRate = (lateCount + missedCount) / repayments.length;
    riskScore += Math.round(lateRate * 60);
    if (missedCount > 0) riskScore += 20;
    if (lateCount > repayments.length * 0.3) riskScore += 10;
    riskScore = Math.min(100, riskScore);

    const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : 'low';

    return {
      loanId,
      totalRepayments: repayments.length,
      riskScore,
      riskLevel,
      lateCount,
      onTimeCount,
      missedCount,
    };
  }

  async getRepaymentEfficiencyScore(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { dueDate: 'asc' },
    });

    if (repayments.length === 0) {
      return {
        loanId,
        totalRepayments: 0,
        efficiencyScore: 100,
        efficiencyLevel: 'no_data',
        onTimeRate: 0,
        earlyPaymentRate: 0,
        avgDaysBeforeDue: 0,
        recommendations: [],
      };
    }

    let onTimeCount = 0;
    let earlyCount = 0;
    let totalDaysBeforeDue = 0;
    let paidCount = 0;

    for (const r of repayments) {
      const status = ((r as any).status || '').toLowerCase();
      if (status === 'paid' || status === 'completed') {
        paidCount++;
        if ((r as any).paidAt && (r as any).dueDate) {
          const paid = new Date((r as any).paidAt).getTime();
          const due = new Date((r as any).dueDate).getTime();
          const daysDiff = Math.round((due - paid) / 86400000);
          if (daysDiff >= 0) {
            onTimeCount++;
            totalDaysBeforeDue += daysDiff;
            if (daysDiff >= 3) earlyCount++;
          }
        } else {
          onTimeCount++;
        }
      }
    }

    const onTimeRate = Math.round((onTimeCount / repayments.length) * 10000) / 100;
    const earlyPaymentRate = paidCount > 0
      ? Math.round((earlyCount / paidCount) * 10000) / 100
      : 0;
    const avgDaysBeforeDue = onTimeCount > 0
      ? Math.round(totalDaysBeforeDue / onTimeCount)
      : 0;

    let efficiencyScore = 0;
    efficiencyScore += Math.round(onTimeRate * 0.6);
    efficiencyScore += Math.round(earlyPaymentRate * 0.3);
    if (avgDaysBeforeDue >= 3) efficiencyScore += 10;
    efficiencyScore = Math.min(100, efficiencyScore);

    const efficiencyLevel = efficiencyScore >= 80 ? 'excellent' : efficiencyScore >= 50 ? 'fair' : 'poor';

    const recommendations: string[] = [];
    if (onTimeRate < 80) recommendations.push('Set up automatic payments to improve on-time rate');
    if (earlyPaymentRate < 20) recommendations.push('Consider paying a few days early to build credit score');
    if (paidCount < repayments.length) recommendations.push('Complete outstanding repayments to improve efficiency');

    return {
      loanId,
      totalRepayments: repayments.length,
      efficiencyScore,
      efficiencyLevel,
      onTimeRate,
      earlyPaymentRate,
      avgDaysBeforeDue,
      recommendations,
    };
  }

  async getRepaymentBehaviorTrend(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({ where: { loanId } });

    if (repayments.length === 0) {
      return {
        totalRepayments: 0,
        trendDirection: 'no_data' as const,
        trendScore: 0,
        monthlyBreakdown: [],
        recommendations: [],
      };
    }

    const monthMap = new Map<string, { count: number; totalPaid: bigint; onTime: number; late: number }>();

    for (const r of repayments) {
      const date = new Date(r.createdAt);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const existing = monthMap.get(key);
      const isLate = r.status === 'LATE' || r.status === 'late' || r.status === 'OVERDUE';

      if (existing) {
        existing.count++;
        existing.totalPaid += r.paidAmount;
        if (isLate) existing.late++;
        else existing.onTime++;
      } else {
        monthMap.set(key, {
          count: 1,
          totalPaid: r.paidAmount,
          onTime: isLate ? 0 : 1,
          late: isLate ? 1 : 0,
        });
      }
    }

    const monthlyBreakdown = Array.from(monthMap.entries())
      .map(([month, data]) => ({
        month,
        count: data.count,
        totalPaid: data.totalPaid.toString(),
        onTimeRate: data.count > 0 ? Math.round((data.onTime / data.count) * 100) : 0,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const paidCount = repayments.filter(r => r.paidAmount > BigInt(0)).length;
    const completionRate = Math.round((paidCount / repayments.length) * 100);

    let trendScore = completionRate;
    const lateCount = repayments.filter(r => r.status === 'LATE' || r.status === 'late' || r.status === 'OVERDUE').length;
    const lateRate = lateCount / repayments.length;
    if (lateRate > 0.3) trendScore -= 30;
    else if (lateRate > 0.1) trendScore -= 15;
    trendScore = Math.max(0, Math.min(100, trendScore));

    const recentMonths = monthlyBreakdown.slice(-3);
    const olderMonths = monthlyBreakdown.slice(0, -3);
    const recentAvg = recentMonths.length > 0 ? recentMonths.reduce((s, m) => s + m.onTimeRate, 0) / recentMonths.length : 0;
    const olderAvg = olderMonths.length > 0 ? olderMonths.reduce((s, m) => s + m.onTimeRate, 0) / olderMonths.length : recentAvg;
    const trendDirection = recentAvg > olderAvg + 5 ? 'improving' : recentAvg < olderAvg - 5 ? 'declining' : 'stable';

    const recommendations: string[] = [];
    if (lateRate > 0.2) recommendations.push('High late payment rate — consider payment reminders');
    if (trendDirection === 'declining') recommendations.push('Payment behavior is declining — review loan terms');
    if (completionRate < 50) recommendations.push('Low completion rate — investigate missed payments');

    return {
      totalRepayments: repayments.length,
      trendDirection,
      trendScore,
      completionRate,
      lateRate: Math.round(lateRate * 100),
      monthlyBreakdown,
      recommendations,
    };
  }

  async getRepaymentCompletionForecast(loanId: string) {
    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { dueDate: 'asc' },
    });

    if (repayments.length === 0) {
      return {
        totalRepayments: 0,
        forecastScore: 0,
        forecastLevel: 'no_data' as const,
        projectedCompletionDays: 0,
        recommendations: [] as string[],
      };
    }

    let paidCount = 0;
    let totalDue = BigInt(0);
    let totalPaid = BigInt(0);

    for (const r of repayments) {
      totalDue += BigInt((r as any).amount ?? 0);
      totalPaid += BigInt((r as any).paidAmount ?? 0);
      if ((r as any).status === 'PAID' || (r as any).paidAt) paidCount++;
    }

    const completionRate = Math.round((paidCount / repayments.length) * 100);
    const remainingCount = repayments.length - paidCount;

    const paidRepayments = repayments.filter((r: any) => r.paidAt);
    let avgDaysBetween = 30;
    if (paidRepayments.length >= 2) {
      let totalDays = 0;
      for (let i = 1; i < paidRepayments.length; i++) {
        const prev = new Date((paidRepayments[i - 1] as any).paidAt).getTime();
        const curr = new Date((paidRepayments[i] as any).paidAt).getTime();
        totalDays += Math.abs(curr - prev) / 86400000;
      }
      avgDaysBetween = Math.round(totalDays / (paidRepayments.length - 1));
    }

    const projectedCompletionDays = remainingCount * Math.max(avgDaysBetween, 1);

    let forecastScore = 50;
    if (completionRate >= 80) forecastScore += 30;
    else if (completionRate >= 50) forecastScore += 15;
    if (projectedCompletionDays < 90) forecastScore += 20;
    else if (projectedCompletionDays > 365) forecastScore -= 15;
    forecastScore = Math.max(0, Math.min(100, forecastScore));

    const forecastLevel = forecastScore >= 70 ? 'on_track'
      : forecastScore >= 40 ? 'at_risk' : 'behind';

    const recommendations: string[] = [];
    if (remainingCount > 0) recommendations.push(`${remainingCount} repayment(s) remaining — est. ${projectedCompletionDays} days`);
    if (forecastLevel === 'behind') recommendations.push('Repayment pace is slower than expected');
    if (forecastLevel === 'on_track') recommendations.push('Repayment is on track for timely completion');

    return {
      totalRepayments: repayments.length,
      paidCount,
      remainingCount,
      completionRate,
      totalDue: totalDue.toString(),
      totalPaid: totalPaid.toString(),
      projectedCompletionDays,
      forecastScore,
      forecastLevel,
      recommendations,
    };
  }
}
