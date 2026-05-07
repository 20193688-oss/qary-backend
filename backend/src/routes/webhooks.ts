import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { StripeLike } from '../lib/stripe.js';
import { audit } from '../lib/audit.js';

interface Deps {
  prisma: PrismaClient;
  stripe: StripeLike;
}

interface RawReq extends FastifyRequest {
  rawBody?: Buffer;
}

export async function registerWebhookRoutes(app: FastifyInstance, deps: Deps) {
  const { prisma, stripe } = deps;

  app.post('/api/webhooks/stripe', async (req, reply) => {
    const rawBody = (req as RawReq).rawBody;
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      app.log.error('STRIPE_WEBHOOK_SECRET missing — refusing webhook');
      return reply.code(500).send({ error: 'webhook_secret_missing' });
    }
    if (!rawBody || typeof sig !== 'string') {
      return reply.code(400).send({ error: 'no_signature_or_body' });
    }

    let event: { id: string; type: string; data: { object: Record<string, unknown> } };
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret) as unknown as typeof event;
    } catch (e) {
      app.log.warn({ err: e }, 'webhook signature verification failed');
      return reply.code(400).send({ error: 'invalid_signature' });
    }

    // Idempotencia por event.id
    const seen = await prisma.event.findFirst({
      where: { eventType: 'webhook.stripe', payload: { path: ['id'], equals: event.id } },
    });
    if (seen) return reply.send({ ok: true, idempotent: true });

    await audit(prisma, {
      actor: 'webhook', eventType: 'webhook.stripe',
      payload: { id: event.id, type: event.type },
      requestId: String(req.id), ip: req.ip,
    });

    if (event.type === 'payment_intent.succeeded') {
      const obj = event.data.object as { id: string };
      await prisma.payment
        .update({
          where: { stripeIntentId: obj.id },
          data: { status: 'SUCCEEDED', capturedAt: new Date() },
        })
        .catch(() => {});
    } else if (event.type === 'payment_intent.payment_failed') {
      const obj = event.data.object as { id: string; last_payment_error?: { code?: string; message?: string } };
      await prisma.payment
        .update({
          where: { stripeIntentId: obj.id },
          data: {
            status: 'FAILED',
            failureCode: obj.last_payment_error?.code,
            failureMessage: obj.last_payment_error?.message,
          },
        })
        .catch(() => {});
    } else if (event.type === 'charge.refunded') {
      const obj = event.data.object as { payment_intent?: string };
      if (obj.payment_intent) {
        await prisma.payment
          .update({
            where: { stripeIntentId: obj.payment_intent },
            data: { status: 'REFUNDED' },
          })
          .catch(() => {});
      }
    }

    return reply.send({ ok: true });
  });
}
