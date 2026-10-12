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
}
