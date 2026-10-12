import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { StripeLike } from '../lib/stripe.js';
import { audit } from '../lib/audit.js';

interface Deps {
  prisma: PrismaClient;
  stripe: StripeLike;
}

const CreateIntentBody = z.object({
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default('usd'),
  description: z.string().optional(),
});

export async function registerPaymentsRoutes(app: FastifyInstance, deps: Deps) {
  const { prisma, stripe } = deps;

  app.post('/api/payments/intent', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = CreateIntentBody.parse(req.body);

    const intent = await stripe.paymentIntents.create({
      amount: body.amountCents,
      currency: body.currency.toLowerCase(),
      capture_method: 'manual',
      metadata: { userId: req.auth!.userId, requestId: String(req.id) },
    });

    const transaction = await prisma.transaction.create({
      data: {
        userId: req.auth!.userId,
        type: 'PAYMENT',
        status: 'PENDING',
        amount: BigInt(body.amountCents),
        currency: body.currency.toUpperCase(),
        description: body.description,
        externalRef: intent.id,
        reference: `STRIPE-${Date.now()}-${intent.id.slice(-8)}`,
      },
    });

    const gatewayPayment = await prisma.gatewayPayment.create({
      data: {
        transactionId: transaction.id,
        status: 'REQUIRES_ACTION',
        paymentMethod: 'CARD',
        amount: BigInt(body.amountCents),
        currency: body.currency.toUpperCase(),
        processorRef: intent.id,
      },
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'payment.intent_created',
      payload: { transactionId: transaction.id, amountCents: body.amountCents, intentId: intent.id },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send({
      paymentId: gatewayPayment.id,
      transactionId: transaction.id,
      clientSecret: (intent as { client_secret?: string | null }).client_secret,
      requiresVoicePin: !!(req.auth && process.env.AGENT_VOICE_PIN_REQUIRED !== 'false'),
    });
  });

  app.get('/api/payments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const gp = await prisma.gatewayPayment.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!gp) return reply.code(404).send({ error: 'not_found' });
    if (gp.transaction.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return reply.send(gp);
  });
}
