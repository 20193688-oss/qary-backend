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
