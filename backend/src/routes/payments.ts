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
  orderId: z.string().min(1),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default('usd'),
});

export async function registerPaymentsRoutes(app: FastifyInstance, deps: Deps) {
  const { prisma, stripe } = deps;

  // Crea PaymentIntent en modo manual_capture: capturamos sólo tras voicePinVerified.
  app.post('/api/payments/intent', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = CreateIntentBody.parse(req.body);
    const order = await prisma.order.findUnique({ where: { id: body.orderId } });
    if (!order) return reply.code(404).send({ error: 'order_not_found' });
    if (order.userId !== req.auth!.userId)
      return reply.code(403).send({ error: 'not_your_order' });

    const intent = await stripe.paymentIntents.create({
      amount: body.amountCents,
      currency: body.currency.toLowerCase(),
      capture_method: 'manual',
      metadata: { orderId: order.id, userId: order.userId, requestId: String(req.id) },
    });

    const payment = await prisma.payment.upsert({
      where: { orderId: order.id },
      update: {
        stripeIntentId: intent.id,
        status: 'REQUIRES_ACTION',
        amountCents: body.amountCents,
        currency: body.currency.toUpperCase(),
        voicePinVerified: false,
        voiceVerifiedAt: null,
        capturedAt: null,
      },
      create: {
        orderId: order.id,
        stripeIntentId: intent.id,
        status: 'REQUIRES_ACTION',
        amountCents: body.amountCents,
        currency: body.currency.toUpperCase(),
      },
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'payment.intent_created',
      payload: { orderId: order.id, paymentId: payment.id, amountCents: body.amountCents, intentId: intent.id },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send({
      paymentId: payment.id,
      clientSecret: (intent as { client_secret?: string | null }).client_secret,
      requiresVoicePin: !!(req.auth && process.env.AGENT_VOICE_PIN_REQUIRED !== 'false'),
    });
  });

  app.get('/api/payments/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = await prisma.payment.findUnique({ where: { id }, include: { order: true } });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.order.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    return reply.send(p);
  });
}
