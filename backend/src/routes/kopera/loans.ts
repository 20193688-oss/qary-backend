import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { LoanService } from '../../kopera/services/loans.js';
import { audit } from '../../lib/audit.js';

export async function registerLoanRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const loans = new LoanService(prisma);

  app.post('/api/loans/simulate', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string().length(3),
      termMonths: z.number().int().min(1).max(360),
      interestRate: z.number().min(0).max(1).optional(),
    }).parse(req.body);

    return loans.simulate(
      Math.round(body.amount * 100),
      body.currency,
      body.termMonths,
      body.interestRate,
    );
  });

  app.post('/api/loans/apply', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string().length(3),
      termMonths: z.number().int().min(1).max(360),
      interestRate: z.number().min(0).max(1).optional(),
    }).parse(req.body);

    const loan = await loans.apply({
      userId: req.auth!.userId,
      principalAmount: BigInt(Math.round(body.amount * 100)),
      currency: body.currency,
      termMonths: body.termMonths,
      interestRate: body.interestRate,
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'loan.applied',
      payload: { loanId: loan.id, amount: body.amount, currency: body.currency },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send(serializeLoan(loan));
  });

  app.get('/api/loans/summary', { preHandler: [app.requireAuth] }, async (req) => {
    const summary = await loans.getLoanSummary(req.auth!.userId);
    return {
      totalLoans: summary.totalLoans,
      totalPrincipal: summary.totalPrincipal.toString(),
      totalOutstanding: summary.totalOutstanding.toString(),
      byStatus: summary.byStatus,
    };
  });

  app.get('/api/loans/overdue-repayments', { preHandler: [app.requireAuth] }, async (req) => {
    const repayments = await loans.getOverdueRepayments(req.auth!.userId);
    return repayments.map((r: any) => ({
      ...r,
      amount: r.amount.toString(),
      paidAmount: r.paidAmount?.toString() ?? '0',
    }));
  });

  app.get('/api/loans/risk-assessment', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await loans.getRiskAssessment(req.auth!.userId);
    return {
      activeLoans: result.activeLoans,
      totalPrincipal: result.totalPrincipal.toString(),
      totalOutstanding: result.totalOutstanding.toString(),
      debtToPrincipalRatio: result.debtToPrincipalRatio,
      overdueInstallments: result.overdueInstallments,
      onTimePercent: result.onTimePercent,
      totalInterestPaid: result.totalInterestPaid.toString(),
      totalInterestRemaining: result.totalInterestRemaining.toString(),
    };
  });

  app.get('/api/loans/amortization-health', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await loans.getAmortizationHealth(req.auth!.userId);
    return {
      activeLoans: result.activeLoans,
      healthScore: result.healthScore,
      totalExpectedPaid: result.totalExpectedPaid.toString(),
      totalActualPaid: result.totalActualPaid.toString(),
      paymentAdherence: result.paymentAdherence,
      overdueInstallments: result.overdueInstallments,
      loanDetails: result.loanDetails.map((d) => ({
        ...d,
        principalAmount: d.principalAmount.toString(),
        expectedPaid: d.expectedPaid.toString(),
        actualPaid: d.actualPaid.toString(),
      })),
    };
  });

  app.get('/api/loans/portfolio-diversification', { preHandler: [app.requireAuth] }, async (req) => {
    return loans.getPortfolioDiversification(req.auth!.userId);
  });

  app.get('/api/loans/interest-cost-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return loans.getInterestCostAnalysis(req.auth!.userId);
  });

  app.get('/api/loans', { preHandler: [app.requireAuth] }, async (req) => {
    const list = await loans.listByUser(req.auth!.userId);
    return list.map(serializeLoan);
  });

  app.post('/api/loans/:id/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const loan = await loans.approve(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'loan.approved',
        payload: { loanId: id }, requestId: String(req.id), ip: req.ip,
      });
      return reply.send(serializeLoan(loan));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'loan_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'loan_not_pending') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/loans/:id/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      reason: z.string().min(1).max(500),
    }).parse(req.body);

    try {
      const loan = await loans.reject(id, body.reason, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'admin', eventType: 'loan.rejected',
        payload: { loanId: id, reason: body.reason },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.send(serializeLoan(loan));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'loan_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'loan_not_pending') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/loans/:id/disburse', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const loan = await loans.disburse(id);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'loan.disbursed',
        payload: { loanId: id }, requestId: String(req.id), ip: req.ip,
      });
      return reply.send(serializeLoan(loan));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'loan_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'loan_not_approved') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.get('/api/loans/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const loan = await loans.getById(id);
    if (!loan) return reply.code(404).send({ error: 'not_found' });
    if (loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return {
      ...serializeLoan(loan),
      repayments: loan.repayments?.map((r: any) => ({
        installment: r.installment,
        dueDate: r.dueDate,
        amount: r.amount.toString(),
        principal: r.principal.toString(),
        interest: r.interest.toString(),
        paidAmount: r.paidAmount.toString(),
        paidAt: r.paidAt,
        status: r.status,
      })),
    };
  });
}

function serializeLoan(loan: any) {
  return {
    id: loan.id,
    status: loan.status,
    principalAmount: loan.principalAmount.toString(),
    currency: loan.currency,
    interestRate: loan.interestRate,
    termMonths: loan.termMonths,
    monthlyPayment: loan.monthlyPayment?.toString(),
    totalInterest: loan.totalInterest?.toString(),
    tcea: loan.tcea,
    outstandingBalance: loan.outstandingBalance?.toString(),
    nextPaymentDate: loan.nextPaymentDate,
    nextPaymentAmount: loan.nextPaymentAmount?.toString(),
    createdAt: loan.createdAt,
  };
}
