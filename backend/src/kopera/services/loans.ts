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
