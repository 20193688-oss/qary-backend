import type { PrismaClient } from '@prisma/client';

interface LoanApplication {
  userId: string;
  principalAmount: bigint;
  currency: string;
  termMonths: number;
  interestRate?: number;
}

export class LoanService {
  constructor(private prisma: PrismaClient) {}

  async apply(params: LoanApplication) {
    const rate = params.interestRate ?? this.getDefaultRate(params.currency);
    const { monthlyPayment, totalInterest, tcea } = this.calculateAmortization(
      Number(params.principalAmount),
      rate,
      params.termMonths,
    );

    return this.prisma.loan.create({
      data: {
        userId: params.userId,
        status: 'APPLICATION',
        principalAmount: params.principalAmount,
        currency: params.currency.toUpperCase(),
        interestRate: rate,
        termMonths: params.termMonths,
        monthlyPayment: BigInt(monthlyPayment),
        totalInterest: BigInt(totalInterest),
        tcea,
      },
    });
  }

  async approve(loanId: string, approvedBy: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new Error('loan_not_found');
    if (loan.status !== 'APPLICATION' && loan.status !== 'UNDERWRITING') {
      throw new Error('loan_not_pending');
    }

    const repayments = this.generateRepaymentSchedule(loan);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.loan.update({
        where: { id: loanId },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedBy },
      });

      await tx.loanRepayment.createMany({
        data: repayments.map((r) => ({ ...r, loanId })),
      });

      return updated;
    });
  }

  async disburse(loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new Error('loan_not_found');
    if (loan.status !== 'APPROVED') throw new Error('loan_not_approved');

    const repayments = await this.prisma.loanRepayment.findMany({
      where: { loanId },
      orderBy: { installment: 'asc' },
    });

    const nextPayment = repayments[0];

    return this.prisma.loan.update({
      where: { id: loanId },
      data: {
        status: 'DISBURSED',
        disbursedAmount: loan.principalAmount,
        disbursedAt: new Date(),
        outstandingBalance: loan.principalAmount + BigInt(loan.totalInterest ?? 0),
        nextPaymentDate: nextPayment?.dueDate,
        nextPaymentAmount: nextPayment?.amount,
      },
    });
  }

  async reject(loanId: string, reason: string, rejectedBy: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new Error('loan_not_found');
    if (loan.status !== 'APPLICATION' && loan.status !== 'UNDERWRITING') {
      throw new Error('loan_not_pending');
    }

    return this.prisma.loan.update({
      where: { id: loanId },
      data: { status: 'REJECTED', rejectedReason: reason, rejectedBy },
    });
  }

  async getById(loanId: string) {
    return this.prisma.loan.findUnique({
      where: { id: loanId },
      include: { repayments: { orderBy: { installment: 'asc' } } },
    });
  }

  async listByUser(userId: string) {
    return this.prisma.loan.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getLoanSummary(userId: string) {
    const loans = await this.prisma.loan.findMany({ where: { userId } });
    let totalPrincipal = BigInt(0);
    let totalOutstanding = BigInt(0);
    const byStatus: Record<string, number> = {};

    for (const loan of loans) {
      totalPrincipal += loan.principalAmount;
      if (loan.outstandingBalance) totalOutstanding += loan.outstandingBalance;
      byStatus[loan.status] = (byStatus[loan.status] ?? 0) + 1;
    }

    return {
      totalLoans: loans.length,
      totalPrincipal,
      totalOutstanding,
      byStatus,
    };
  }

  async getOverdueRepayments(userId: string) {
    const loans = await this.prisma.loan.findMany({ where: { userId } });
    const loanIds = new Set(loans.map((l: any) => l.id));
    if (loanIds.size === 0) return [];

    const now = new Date();
    const allRepayments = await this.prisma.loanRepayment.findMany({});
    return allRepayments
      .filter((r: any) => loanIds.has(r.loanId) && r.status !== 'PAID' && r.dueDate < now)
      .map((r: any) => ({
        id: r.id,
        loanId: r.loanId,
        installment: r.installment,
        dueDate: r.dueDate,
        amount: r.amount,
        paidAmount: r.paidAmount,
        status: r.status,
        daysOverdue: Math.floor((now.getTime() - r.dueDate.getTime()) / (1000 * 60 * 60 * 24)),
      }));
  }

  async getRiskAssessment(userId: string) {
    const loans = await this.prisma.loan.findMany({ where: { userId } });
    const activeStatuses = new Set(['APPROVED', 'DISBURSED']);
    const activeLoans = loans.filter((l: any) => activeStatuses.has(l.status));

    let totalPrincipal = BigInt(0);
    let totalOutstanding = BigInt(0);
    let totalInterestPaid = BigInt(0);
    let totalInterestRemaining = BigInt(0);

    for (const l of activeLoans) {
      totalPrincipal += l.principalAmount;
      if (l.outstandingBalance) totalOutstanding += l.outstandingBalance;
      const totalInt = l.totalInterest ?? BigInt(0);
      const outBal = l.outstandingBalance ?? BigInt(0);
      const principal = l.principalAmount;
      if (outBal <= principal) {
        totalInterestPaid += totalInt;
      } else {
        const interestPortion = outBal - principal;
        totalInterestRemaining += interestPortion > totalInt ? totalInt : interestPortion;
        totalInterestPaid += totalInt - (interestPortion > totalInt ? totalInt : interestPortion);
      }
    }

    const loanIds = new Set(activeLoans.map((l: any) => l.id));
    let overdueCount = 0;
    let onTimeCount = 0;
    let totalRepayments = 0;

    if (loanIds.size > 0) {
      const allRepayments = await this.prisma.loanRepayment.findMany({});
      const relevant = allRepayments.filter((r: any) => loanIds.has(r.loanId));
      totalRepayments = relevant.length;
      for (const r of relevant) {
        if (r.status === 'OVERDUE') overdueCount++;
        else if (r.status === 'PAID') onTimeCount++;
      }
    }

    const onTimePercent = totalRepayments > 0
      ? Math.round(onTimeCount / totalRepayments * 10000) / 100
      : 100;
    const debtToPrincipalRatio = totalPrincipal > BigInt(0)
      ? Math.round(Number(totalOutstanding * BigInt(10000) / totalPrincipal)) / 100
      : 0;

    return {
      activeLoans: activeLoans.length,
      totalPrincipal,
      totalOutstanding,
      debtToPrincipalRatio,
      overdueInstallments: overdueCount,
      onTimePercent,
      totalInterestPaid,
      totalInterestRemaining,
    };
  }

  async getAmortizationHealth(userId: string) {
    const loans = await this.prisma.loan.findMany({ where: { userId } });
    const activeStatuses = new Set(['APPROVED', 'DISBURSED']);
    const activeLoans = loans.filter((l: any) => activeStatuses.has(l.status));

    if (activeLoans.length === 0) {
      return {
        activeLoans: 0,
        healthScore: 100,
        totalExpectedPaid: BigInt(0),
        totalActualPaid: BigInt(0),
        paymentAdherence: 100,
        overdueInstallments: 0,
        loanDetails: [] as { loanId: string; currency: string; principalAmount: bigint; expectedPaid: bigint; actualPaid: bigint; adherencePercent: number; overdueCount: number; status: string }[],
      };
    }

    const loanIds = new Set(activeLoans.map((l: any) => l.id));
    const allRepayments = await this.prisma.loanRepayment.findMany({});
    const repayments = allRepayments.filter((r: any) => loanIds.has(r.loanId));

    const now = new Date();
    let totalExpectedPaid = BigInt(0);
    let totalActualPaid = BigInt(0);
    let totalOverdue = 0;
    let totalDue = 0;
    let totalPaidOnTime = 0;

    const repaymentsByLoan: Record<string, any[]> = {};
    for (const r of repayments) {
      if (!repaymentsByLoan[r.loanId]) repaymentsByLoan[r.loanId] = [];
      repaymentsByLoan[r.loanId].push(r);
    }

    const loanDetails: { loanId: string; currency: string; principalAmount: bigint; expectedPaid: bigint; actualPaid: bigint; adherencePercent: number; overdueCount: number; status: string }[] = [];

    for (const loan of activeLoans) {
      const loanRepayments = repaymentsByLoan[loan.id] ?? [];
      let expectedPaid = BigInt(0);
      let actualPaid = BigInt(0);
      let overdueCount = 0;

      for (const r of loanRepayments) {
        if (r.dueDate <= now) {
          totalDue++;
          expectedPaid += r.amount;
          if (r.status === 'PAID') {
            actualPaid += r.paidAmount ?? r.amount;
            totalPaidOnTime++;
          } else {
            overdueCount++;
            totalOverdue++;
            actualPaid += r.paidAmount ?? BigInt(0);
          }
        }
      }

      totalExpectedPaid += expectedPaid;
      totalActualPaid += actualPaid;

      const adherencePercent = expectedPaid > BigInt(0)
        ? Math.round(Number(actualPaid * BigInt(10000) / expectedPaid)) / 100
        : 100;

      loanDetails.push({
        loanId: loan.id,
        currency: loan.currency,
        principalAmount: loan.principalAmount,
        expectedPaid,
        actualPaid,
        adherencePercent,
        overdueCount,
        status: overdueCount > 0 ? 'behind' : 'on_track',
      });
    }

    const paymentAdherence = totalDue > 0
      ? Math.round(totalPaidOnTime / totalDue * 10000) / 100
      : 100;

    const healthScore = Math.max(0, 100 - totalOverdue * 20);

    return {
      activeLoans: activeLoans.length,
      healthScore,
      totalExpectedPaid,
      totalActualPaid,
      paymentAdherence,
      overdueInstallments: totalOverdue,
      loanDetails,
    };
  }

  async simulate(principalAmount: number, currency: string, termMonths: number, interestRate?: number) {
    const rate = interestRate ?? this.getDefaultRate(currency);
    const { monthlyPayment, totalInterest, tcea } = this.calculateAmortization(
      principalAmount,
      rate,
      termMonths,
    );

    const schedule = [];
    let balance = principalAmount;
    const monthlyRate = rate / 12;

    for (let i = 1; i <= termMonths; i++) {
      const interestPortion = Math.round(balance * monthlyRate);
      const principalPortion = monthlyPayment - interestPortion;
      balance -= principalPortion;
      schedule.push({
        installment: i,
        payment: monthlyPayment,
        principal: principalPortion,
        interest: interestPortion,
        balance: Math.max(0, balance),
      });
    }

    return {
      principalAmount,
      currency: currency.toUpperCase(),
      termMonths,
      interestRate: rate,
      monthlyPayment,
      totalInterest,
      totalPayment: principalAmount + totalInterest,
      tcea,
      schedule,
    };
  }

  private calculateAmortization(principal: number, annualRate: number, termMonths: number) {
    const monthlyRate = annualRate / 12;
    const monthlyPayment =
      monthlyRate === 0
        ? Math.round(principal / termMonths)
        : Math.round(
            principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) /
            (Math.pow(1 + monthlyRate, termMonths) - 1),
          );
    const totalPayment = monthlyPayment * termMonths;
    const totalInterest = totalPayment - principal;
    const tcea = Number((Math.pow(1 + monthlyRate, 12) - 1).toFixed(4));

    return { monthlyPayment, totalInterest, tcea };
  }

  private generateRepaymentSchedule(loan: {
    principalAmount: bigint;
    interestRate: number;
    termMonths: number;
    monthlyPayment: bigint | null;
  }) {
    const principal = Number(loan.principalAmount);
    const monthlyRate = loan.interestRate / 12;
    const payment = Number(loan.monthlyPayment ?? 0);
    let balance = principal;
    const now = new Date();
    const repayments = [];

    for (let i = 1; i <= loan.termMonths; i++) {
      const interest = Math.round(balance * monthlyRate);
      const principalPortion = payment - interest;
      balance -= principalPortion;

      const dueDate = new Date(now);
      dueDate.setMonth(dueDate.getMonth() + i);

      repayments.push({
        installment: i,
        dueDate,
        amount: BigInt(payment),
        principal: BigInt(principalPortion),
        interest: BigInt(interest),
      });
    }

    return repayments;
  }

  private getDefaultRate(currency: string): number {
    const rates: Record<string, number> = {
      PEN: 0.18, USD: 0.12, EUR: 0.08, MXN: 0.22, BRL: 0.25,
      CLP: 0.15, COP: 0.20, ARS: 0.65, GBP: 0.09,
    };
    return rates[currency.toUpperCase()] ?? 0.15;
  }
}
