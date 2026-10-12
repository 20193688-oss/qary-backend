import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { audit } from '../../lib/audit.js';
import { AgentOrchestrator } from '../../kopera/agents/orchestrator.js';
import { GatewayPaymentService } from '../../kopera/services/gateway.js';
import { PaymentLinkService } from '../../kopera/services/payment-links.js';
import { TransactionLimitService } from '../../kopera/services/transaction-limits.js';
import { DisputeService } from '../../kopera/services/disputes.js';
import '../../kopera/agents/definitions.js';

export async function registerGatewayRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const orchestrator = new AgentOrchestrator(prisma);
  const gateway = new GatewayPaymentService(prisma);
  const linkSvc = new PaymentLinkService(prisma);
  const limitSvc = new TransactionLimitService(prisma);
  const disputeSvc = new DisputeService(prisma);

  app.post('/api/gateway/payments', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string().length(3),
      paymentMethod: z.enum([
        'CARD', 'BANK_TRANSFER', 'WALLET', 'QR_CODE',
        'APPLE_PAY', 'GOOGLE_PAY', 'PIX', 'SPEI',
        'SEPA', 'ACH', 'UPI', 'STABLECOIN',
      ]),
      cardToken: z.string().optional(),
      accountNumber: z.string().optional(),
      description: z.string().optional(),
      merchantId: z.string().optional(),
      idempotencyKey: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const idempotencyKey = body.idempotencyKey ?? randomUUID();

    const existing = await gateway.findByIdempotencyKey(idempotencyKey);
    if (existing) return reply.send(serializeGatewayPayment(existing));

    const results = await orchestrator.executeParallel(
      [3, 26],
      {
        amount: Math.round(body.amount * 100),
        currency: body.currency,
        userId: req.auth!.userId,
      },
      { userId: req.auth!.userId },
    );
    const antifraudResult = results[0];

    const antifraudScore = (antifraudResult?.data?.['score'] as number) ?? 0;
    const antifraudDecision = (antifraudResult?.data?.['decision'] as string) ?? 'APPROVE';

    if (antifraudDecision === 'DECLINE') {
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'agent', eventType: 'gateway.payment_declined',
        payload: { reason: 'antifraud', score: antifraudScore, amount: body.amount },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(403).send({
        error: 'payment_declined',
        reason: 'Transaction flagged by antifraud system',
      });
    }

    const amountCents = BigInt(Math.round(body.amount * 100));

    const limitCheck = await limitSvc.checkAndIncrement(
      req.auth!.userId,
      body.currency.toUpperCase(),
      amountCents,
    );
    if (!limitCheck.allowed) {
      return reply.code(429).send({
        error: 'transaction_limit_exceeded',
        reason: limitCheck.reason,
      });
    }

    const { gatewayPayment } = await gateway.createPayment({
      userId: req.auth!.userId,
      amount: amountCents,
      currency: body.currency.toUpperCase(),
      paymentMethod: body.paymentMethod,
      description: body.description,
      merchantId: body.merchantId,
      idempotencyKey,
      antifraudScore,
      antifraudDecision,
      antifraudDetails: (antifraudResult?.data ?? {}) as object,
      metadata: body.metadata as object,
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'gateway.payment_created',
      payload: {
        gatewayPaymentId: gatewayPayment.id,
        amount: body.amount,
        currency: body.currency,
        method: body.paymentMethod,
        antifraudDecision,
      },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send(serializeGatewayPayment(gatewayPayment));
  });

  app.get('/api/gateway/payments/stats', { preHandler: [app.requireAuth] }, async (req) => {
    const stats = await gateway.getPaymentStats(req.auth!.userId);
    return {
      totalPayments: stats.totalPayments,
      totalVolume: stats.totalVolume.toString(),
      totalFees: stats.totalFees.toString(),
      avgTransactionSize: stats.avgTransactionSize.toString(),
      byMethod: stats.byMethod,
      byStatus: stats.byStatus,
    };
  });

  app.get('/api/gateway/pending-settlements', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await gateway.getPendingSettlements(req.auth!.userId);
    return {
      totalPending: result.totalPending.toString(),
      count: result.count,
      items: result.items.map((i: any) => ({
        ...i,
        amount: i.amount.toString(),
      })),
    };
  });

  app.get('/api/gateway/payments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const gp = await gateway.findById(id);
    if (!gp) return reply.code(404).send({ error: 'not_found' });
    if (gp.transaction.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return serializeGatewayPayment(gp);
  });

  app.get('/api/gateway/payments', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; status?: string };
    const payments = await gateway.listByUser(req.auth!.userId, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      status: query.status,
    });
    return payments.map(serializeGatewayPayment);
  });

  app.post('/api/gateway/payments/:id/capture', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const gp = await gateway.capture(id);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'gateway.payment_captured',
        payload: { gatewayPaymentId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serializeGatewayPayment(gp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'not_found') return reply.code(404).send({ error: msg });
      if (msg === 'cannot_capture') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/gateway/payments/:id/void', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const gp = await gateway.void(id);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'gateway.payment_voided',
        payload: { gatewayPaymentId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serializeGatewayPayment(gp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'not_found') return reply.code(404).send({ error: msg });
      if (msg === 'cannot_void') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/gateway/payments/:id/settle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      settlementAmount: z.number().positive().optional(),
      settlementCurrency: z.string().length(3).optional(),
    }).parse(req.body);

    try {
      const settlementCents = body.settlementAmount ? BigInt(Math.round(body.settlementAmount * 100)) : undefined;
      const gp = await gateway.settle(id, settlementCents, body.settlementCurrency?.toUpperCase());
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'gateway.payment_settled',
        payload: { gatewayPaymentId: id, settlementAmount: body.settlementAmount },
        requestId: String(req.id), ip: req.ip,
      });
      return serializeGatewayPayment(gp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'not_found') return reply.code(404).send({ error: msg });
      if (msg === 'cannot_settle') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/gateway/payments/:id/refund', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      amount: z.number().positive().optional(),
      reason: z.string().optional(),
    }).parse(req.body);

    try {
      const refundCents = body.amount ? BigInt(Math.round(body.amount * 100)) : undefined;
      const result = await gateway.refund(id, refundCents, body.reason);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'gateway.refund',
        payload: { gatewayPaymentId: id, amount: Number(result.amount) },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.send({ refunded: true, amount: result.amount.toString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'not_found') return reply.code(404).send({ error: msg });
      if (msg === 'cannot_refund_status') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/gateway/payments/:id/dispute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      reason: z.string().min(1).max(1000),
      amount: z.number().positive().optional(),
    }).parse(req.body);

    try {
      const gp = await gateway.findById(id);
      if (!gp) return reply.code(404).send({ error: 'not_found' });
      if (gp.transaction.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

      const disputeAmount = body.amount
        ? BigInt(Math.round(body.amount * 100))
        : gp.amount;

      const dispute = await disputeSvc.create({
        userId: req.auth!.userId,
        gatewayPaymentId: id,
        reason: body.reason,
        amount: disputeAmount,
        currency: gp.currency,
      });

      await prisma.gatewayPayment.update({
        where: { id },
        data: { status: 'DISPUTED' },
      });

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'gateway.dispute_created',
        payload: { gatewayPaymentId: id, disputeId: dispute.id, reason: body.reason },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.code(201).send({
        id: dispute.id,
        gatewayPaymentId: id,
        reason: dispute.reason,
        amount: dispute.amount.toString(),
        currency: dispute.currency,
        status: dispute.status,
        evidenceDeadline: dispute.evidenceDeadline,
        createdAt: dispute.createdAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'payment_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'dispute_already_exists') return reply.code(409).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/gateway/payment-links', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string().length(3),
      description: z.string().optional(),
      expiresInMinutes: z.number().int().positive().default(60),
    }).parse(req.body);

    const amountCents = BigInt(Math.round(body.amount * 100));
    const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60 * 1000);

    const link = await linkSvc.create({
      userId: req.auth!.userId,
      amount: amountCents,
      currency: body.currency,
      description: body.description,
      expiresAt,
    });

    const baseUrl = process.env.APP_BASE_URL ?? 'https://pay.kopera.io';

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'gateway.payment_link_created',
      payload: { linkId: link.id, amount: body.amount, currency: body.currency },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send({
      id: link.id,
      code: link.code,
      url: `${baseUrl}/pay/${link.code}`,
      amount: link.amount.toString(),
      currency: link.currency,
      description: link.description,
      status: link.status,
      expiresAt: link.expiresAt?.toISOString() ?? null,
    });
  });

  // Webhook delivery confirmation
  app.post('/api/gateway/payments/:id/webhook-delivered', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const gp = await gateway.markWebhookDelivered(id);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'system', eventType: 'gateway.webhook_delivered',
        payload: { gatewayPaymentId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serializeGatewayPayment(gp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'not_found') return reply.code(404).send({ error: msg });
      if (msg === 'already_delivered') return reply.code(400).send({ error: msg });
      throw err;
    }
  });
}

function serializeGatewayPayment(gp: any) {
  return {
    id: gp.id,
    transactionId: gp.transactionId,
    status: gp.status,
    paymentMethod: gp.paymentMethod,
    amount: gp.amount.toString(),
    currency: gp.currency,
    cardNetwork: gp.cardNetwork,
    cardLast4: gp.cardLast4,
    threeDSecureStatus: gp.threeDSecureStatus,
    gatewayFee: gp.gatewayFee.toString(),
    antifraudScore: gp.antifraudScore,
    antifraudDecision: gp.antifraudDecision,
    idempotencyKey: gp.idempotencyKey,
    webhookDelivered: gp.webhookDelivered,
    settlementAmount: gp.settlementAmount?.toString() ?? null,
    settlementCurrency: gp.settlementCurrency ?? null,
    settledAt: gp.settledAt ?? null,
    createdAt: gp.createdAt,
  };
}
