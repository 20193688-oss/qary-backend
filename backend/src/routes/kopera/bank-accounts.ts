import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { BankAccountService } from '../../kopera/services/bank-accounts.js';
import { audit } from '../../lib/audit.js';

const RAILS = ['CCI', 'CLABE', 'CBU', 'CVU', 'PIX', 'IBAN', 'SWIFT', 'ACH', 'SORT_CODE', 'BSB', 'IFSC', 'SPEI', 'SEPA', 'UPI', 'FASTER_PAYMENTS'] as const;

function serialize(a: any) {
  return {
    id: a.id,
    bankName: a.bankName,
    bankCode: a.bankCode,
    accountNumberLast4: a.accountNumber?.slice(-4),
    accountType: a.accountType,
    rail: a.rail,
    country: a.country,
    currency: a.currency,
    holderName: a.holderName,
    isVerified: a.isVerified,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
  };
}

export async function registerBankAccountRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new BankAccountService(prisma);

  app.post('/api/bank-accounts', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      bankName: z.string().min(1).max(200),
      bankCode: z.string().optional(),
      accountNumber: z.string().min(4).max(40),
      accountType: z.enum(['savings', 'checking']).optional(),
      rail: z.enum(RAILS),
      country: z.string().length(2),
      currency: z.string().length(3),
      holderName: z.string().min(1).max(200),
    }).parse(req.body);

    try {
      const acct = await svc.addAccount(req.auth!.userId, body);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'bank_account.added',
        payload: { bankName: body.bankName, rail: body.rail, country: body.country },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(201).send(serialize(acct));
    } catch (err: any) {
      if (err.message === 'account_already_exists') return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/bank-accounts', { preHandler: [app.requireAuth] }, async (req) => {
    const accounts = await svc.listAccounts(req.auth!.userId);
    return accounts.map(serialize);
  });

  app.get('/api/bank-accounts/verification-overview', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getVerificationOverview(req.auth!.userId);
  });

  app.get('/api/bank-accounts/payout-readiness', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getPayoutReadiness(req.auth!.userId);
  });

  app.get('/api/bank-accounts/coverage-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getCoverageAnalysis(req.auth!.userId);
  });

  app.get('/api/bank-accounts/rail-distribution', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getRailDistribution(req.auth!.userId);
  });

  app.patch('/api/bank-accounts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      holderName: z.string().min(1).max(200).optional(),
      bankName: z.string().min(1).max(200).optional(),
      bankCode: z.string().optional(),
      accountType: z.enum(['savings', 'checking']).optional(),
    }).parse(req.body);

    try {
      const acct = await svc.updateAccount(id, req.auth!.userId, body);
      return serialize(acct);
    } catch (err: any) {
      if (err.message === 'account_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/bank-accounts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const acct = await svc.getAccount(id);
    if (!acct || acct.userId !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return serialize(acct);
  });

  app.post('/api/bank-accounts/:id/default', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const acct = await svc.setDefault(id, req.auth!.userId);
      return serialize(acct);
    } catch (err: any) {
      if (err.message === 'account_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/bank-accounts/:id/verify', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const acct = await svc.verify(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'bank_account.verified',
        payload: { bankAccountId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(acct);
    } catch (err: any) {
      if (err.message === 'account_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_verified') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/bank-accounts/:id/initiate-verification', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const acct = await svc.initiateVerification(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'bank_account.verification_initiated',
        payload: { bankAccountId: id },
        requestId: String(req.id), ip: req.ip,
      });
      const meta = acct.metadata as Record<string, unknown>;
      return { message: 'micro_deposits_sent', microDeposit1: meta.microDeposit1, microDeposit2: meta.microDeposit2 };
    } catch (err: any) {
      if (err.message === 'account_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_verified') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/bank-accounts/:id/confirm-verification', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      amount1: z.number().int().positive(),
      amount2: z.number().int().positive(),
    }).parse(req.body);

    try {
      const acct = await svc.confirmVerification(id, req.auth!.userId, body.amount1, body.amount2);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'bank_account.verified',
        payload: { bankAccountId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(acct);
    } catch (err: any) {
      if (err.message === 'account_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_verified') return reply.code(400).send({ error: err.message });
      if (err.message === 'verification_not_initiated') return reply.code(400).send({ error: err.message });
      if (err.message === 'amounts_mismatch') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/bank-accounts/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await svc.removeAccount(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'bank_account.removed',
        payload: { bankAccountId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(204).send();
    } catch (err: any) {
      if (err.message === 'account_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });
}
