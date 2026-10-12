import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { audit } from '../../lib/audit.js';
import { AgentOrchestrator } from '../../kopera/agents/orchestrator.js';
import '../../kopera/agents/definitions.js';

export async function registerGatewayRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const orchestrator = new AgentOrchestrator(prisma);

  // Create a payment through the Kopera gateway
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

    // Check for duplicate
    const existing = await prisma.gatewayPayment.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      return reply.send(serializeGatewayPayment(existing));
    }

    // Run antifraud in parallel with payment processing
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
    const reference = `GW-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const transaction = await prisma.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'PAYMENT',
        status: antifraudDecision === 'REVIEW' ? 'PROCESSING' : 'COMPLETED',
        amount: amountCents,
        currency: body.currency.toUpperCase(),
        description: body.description,
        reference,
        paymentMethodUsed: body.paymentMethod as any,
        metadata: (body.metadata ?? {}) as object,
        processedAt: antifraudDecision === 'APPROVE' ? new Date() : undefined,
      },
    });

    const gatewayPayment = await prisma.gatewayPayment.create({
      data: {
        transactionId: transaction.id,
        merchantId: body.merchantId,
        status: antifraudDecision === 'REVIEW' ? 'REQUIRES_ACTION' : 'CAPTURED',
        paymentMethod: body.paymentMethod as any,
        amount: amountCents,
        currency: body.currency.toUpperCase(),
        antifraudScore,
        antifraudDecision,
        antifraudDetails: (antifraudResult?.data ?? {}) as object,
        idempotencyKey,
        threeDSecureStatus: body.paymentMethod === 'CARD' && body.amount > 100 ? 'required' : 'not_required',
      },
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

  app.get('/api/gateway/payments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const gp = await prisma.gatewayPayment.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!gp) return reply.code(404).send({ error: 'not_found' });
    if (gp.transaction.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return serializeGatewayPayment(gp);
  });

  app.get('/api/gateway/payments', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; status?: string };
    const payments = await prisma.gatewayPayment.findMany({
      where: {
        transaction: { userId: req.auth!.userId },
        ...(query.status ? { status: query.status as any } : {}),
      },
      take: Math.min(Number(query.limit ?? 20), 100),
      skip: Number(query.offset ?? 0),
      orderBy: { createdAt: 'desc' },
    });
    return payments.map(serializeGatewayPayment);
  });

  // Refund a gateway payment
  app.post('/api/gateway/payments/:id/refund', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      amount: z.number().positive().optional(),
      reason: z.string().optional(),
    }).parse(req.body);

    const gp = await prisma.gatewayPayment.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!gp) return reply.code(404).send({ error: 'not_found' });
    if (gp.status !== 'CAPTURED' && gp.status !== 'SETTLED') {
      return reply.code(400).send({ error: 'cannot_refund_status' });
    }

    const refundAmount = body.amount ? BigInt(Math.round(body.amount * 100)) : gp.amount;

    await prisma.$transaction(async (tx) => {
      await tx.gatewayPayment.update({
        where: { id },
        data: { status: 'REFUNDED' },
      });
      await tx.transaction.update({
        where: { id: gp.transactionId },
        data: { status: 'REVERSED' },
      });
      await tx.transaction.create({
        data: {
          userId: gp.transaction.userId,
          type: 'REFUND',
          status: 'COMPLETED',
          amount: refundAmount,
          currency: gp.currency,
          description: body.reason ?? 'Refund',
          reference: `REF-${Date.now()}-${randomUUID().slice(0, 8)}`,
          reversalOf: gp.transactionId,
          processedAt: new Date(),
        },
      });
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'gateway.refund',
      payload: { gatewayPaymentId: id, amount: Number(refundAmount) },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send({ refunded: true, amount: refundAmount.toString() });
  });

  // Payment link generation
  app.post('/api/gateway/payment-links', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string().length(3),
      description: z.string().optional(),
      expiresInMinutes: z.number().int().positive().default(60),
    }).parse(req.body);

    const linkId = randomUUID().replace(/-/g, '').slice(0, 16);
    const baseUrl = process.env.APP_BASE_URL ?? 'https://pay.kopera.io';

    return reply.code(201).send({
      linkId,
      url: `${baseUrl}/pay/${linkId}`,
      amount: body.amount,
      currency: body.currency.toUpperCase(),
      description: body.description,
      expiresAt: new Date(Date.now() + body.expiresInMinutes * 60 * 1000).toISOString(),
    });
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
    antifraudScore: gp.antifraudScore,
    antifraudDecision: gp.antifraudDecision,
    idempotencyKey: gp.idempotencyKey,
    createdAt: gp.createdAt,
  };
}
