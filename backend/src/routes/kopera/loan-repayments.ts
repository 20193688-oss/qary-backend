import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { LoanRepaymentService } from '../../kopera/services/loan-repayments.js';
import { audit } from '../../lib/audit.js';

function serialize(r: any) {
  return {
    id: r.id,
    loanId: r.loanId,
    installment: r.installment,
    dueDate: r.dueDate,
    amount: r.amount.toString(),
    principal: r.principal.toString(),
    interest: r.interest.toString(),
    paidAmount: r.paidAmount.toString(),
    paidAt: r.paidAt,
    status: r.status,
    createdAt: r.createdAt,
  };
}

export async function registerLoanRepaymentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new LoanRepaymentService(prisma);

  app.get('/api/loans/:loanId/repayments', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { loanId } = req.params as { loanId: string };

    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) return reply.code(404).send({ error: 'loan_not_found' });
    if (loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const repayments = await svc.listByLoan(loanId);
    return repayments.map(serialize);
  });

  app.get('/api/loans/:loanId/repayments/summary', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { loanId } = req.params as { loanId: string };

    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) return reply.code(404).send({ error: 'loan_not_found' });
    if (loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const summary = await svc.getScheduleSummary(loanId);
    return {
      ...summary,
      totalDue: summary.totalDue.toString(),
      totalPaid: summary.totalPaid.toString(),
      remaining: summary.remaining.toString(),
    };
  });

  app.get('/api/loans/:loanId/early-payoff', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { loanId } = req.params as { loanId: string };

    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) return reply.code(404).send({ error: 'loan_not_found' });
    if (loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    try {
      const result = await svc.calculateEarlyPayoff(loanId);
      return {
        loanId: result.loanId,
        payoffAmount: result.payoffAmount.toString(),
        savedInterest: result.savedInterest.toString(),
        remainingInstallments: result.remainingInstallments,
        originalTermMonths: result.originalTermMonths,
      };
    } catch (e: any) {
      if (e.message === 'loan_not_active') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/loans/:loanId/repayments/delinquency', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { loanId } = req.params as { loanId: string };

    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) return reply.code(404).send({ error: 'loan_not_found' });
    if (loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const result = await svc.getDelinquencyReport(loanId);
    return {
      ...result,
      overdueAmount: result.overdueAmount.toString(),
      overdueInstallments: result.overdueInstallments.map((i) => ({
        ...i,
        amount: i.amount.toString(),
        paidAmount: i.paidAmount.toString(),
      })),
    };
  });

  app.get('/api/loans/:loanId/repayments/amortization', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { loanId } = req.params as { loanId: string };

    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) return reply.code(404).send({ error: 'loan_not_found' });
    if (loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const result = await svc.getAmortizationAnalysis(loanId);
    return {
      ...result,
      totalPrincipal: result.totalPrincipal.toString(),
      totalInterest: result.totalInterest.toString(),
      totalCost: result.totalCost.toString(),
      principalPaidSoFar: result.principalPaidSoFar.toString(),
      interestPaidSoFar: result.interestPaidSoFar.toString(),
      principalRemaining: result.principalRemaining.toString(),
      interestRemaining: result.interestRemaining.toString(),
      schedule: result.schedule.map((s) => ({
        ...s,
        principal: s.principal.toString(),
        interest: s.interest.toString(),
        total: s.total.toString(),
        cumulativePrincipal: s.cumulativePrincipal.toString(),
        cumulativeInterest: s.cumulativeInterest.toString(),
      })),
    };
  });

  app.get('/api/loans/:loanId/repayments/payment-history', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { loanId } = req.params as { loanId: string };

    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) return reply.code(404).send({ error: 'loan_not_found' });
    if (loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    const result = await svc.getPaymentHistory(loanId);
    return {
      loanId: result.loanId,
      totalInstallments: result.totalInstallments,
      totalOwed: result.totalOwed.toString(),
      totalPaid: result.totalPaid.toString(),
      remaining: result.remaining.toString(),
      onTimePayments: result.onTimePayments,
      latePayments: result.latePayments,
      payments: result.payments.map(p => ({
        ...p,
        amount: p.amount.toString(),
        paidAmount: p.paidAmount.toString(),
      })),
    };
  });

  app.get('/api/repayments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repayment = await svc.getById(id);
    if (!repayment) return reply.code(404).send({ error: 'not_found' });

    const loan = await prisma.loan.findUnique({ where: { id: repayment.loanId } });
    if (!loan || loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    return serialize(repayment);
  });

  app.post('/api/loan-repayments/process-due', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const result = await svc.processDueRepayments();

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'system', eventType: 'loan.repayments_processed',
      payload: { processed: result.processed },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send(result);
  });

  app.post('/api/repayments/:id/mark-overdue', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    try {
      const updated = await svc.markOverdue(id);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'admin', eventType: 'loan.repayment_marked_overdue',
        payload: { repaymentId: id, loanId: updated.loanId },
        requestId: String(req.id), ip: req.ip,
      });

      return serialize(updated);
    } catch (e: any) {
      if (e.message === 'repayment_not_found') return reply.code(404).send({ error: e.message });
      if (e.message === 'already_paid') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/repayments/:id/pay', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      amount: z.number().positive(),
    }).parse(req.body);

    const repayment = await svc.getById(id);
    if (!repayment) return reply.code(404).send({ error: 'not_found' });

    const loan = await prisma.loan.findUnique({ where: { id: repayment.loanId } });
    if (!loan || loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    try {
      const amountCents = BigInt(Math.round(body.amount * 100));
      const updated = await svc.makePayment(id, amountCents);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'loan.repayment_made',
        payload: { repaymentId: id, loanId: repayment.loanId, amount: body.amount },
        requestId: String(req.id), ip: req.ip,
      });

      return serialize(updated);
    } catch (e: any) {
      if (e.message === 'already_paid') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
}
