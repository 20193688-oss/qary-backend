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

  app.get('/api/repayments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repayment = await svc.getById(id);
    if (!repayment) return reply.code(404).send({ error: 'not_found' });

    const loan = await prisma.loan.findUnique({ where: { id: repayment.loanId } });
    if (!loan || loan.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    return serialize(repayment);
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
