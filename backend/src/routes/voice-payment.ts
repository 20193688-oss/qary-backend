import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { StripeLike } from '../lib/stripe.js';
import { verifySecret } from '../lib/password.js';
import { audit } from '../lib/audit.js';

interface Deps {
  prisma: PrismaClient;
  stripe: StripeLike;
}

const VoiceConfirmBody = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1),
  confirmPin: z.string().regex(/^\d{4}$/),
});

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const failureCounts = new Map<string, { count: number; firstAt: number }>();

function consume(userId: string): boolean {
  const now = Date.now();
  const entry = failureCounts.get(userId);
  if (!entry || now - entry.firstAt > RATE_LIMIT_WINDOW_MS) {
    failureCounts.set(userId, { count: 1, firstAt: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

export async function registerVoicePaymentRoutes(app: FastifyInstance, deps: Deps) {
  const { prisma, stripe } = deps;

  app.post('/api/voice-confirm', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = VoiceConfirmBody.parse(req.body);
    if (req.auth!.userId !== body.userId)
      return reply.code(403).send({ error: 'user_mismatch' });

    if (!consume(body.userId)) {
      await audit(prisma, {
        userId: body.userId, actor: 'user', eventType: 'voice.rate_limited',
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(429).send({ error: 'too_many_attempts' });
    }

    const user = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!user || !user.pinHash)
      return reply.code(400).send({ error: 'pin_not_set' });

    const ok = await verifySecret(body.confirmPin, user.pinHash);
    if (!ok) {
      await audit(prisma, {
        userId: body.userId, actor: 'user', eventType: 'voice.pin_invalid',
        payload: { orderId: body.orderId }, requestId: String(req.id), ip: req.ip,
      });
      return reply.code(401).send({ error: 'invalid_pin' });
    }

    const payment = await prisma.payment.findUnique({
      where: { orderId: body.orderId }, include: { order: true },
    });
    if (!payment) return reply.code(404).send({ error: 'payment_not_found' });
    if (payment.order.userId !== body.userId)
      return reply.code(403).send({ error: 'forbidden' });
    if (payment.status === 'SUCCEEDED')
      return reply.code(409).send({ error: 'already_captured' });

    // Marcar verificado y capturar
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { voicePinVerified: true, voiceVerifiedAt: new Date() },
    });

    let captured;
    try {
      captured = await stripe.paymentIntents.capture(payment.stripeIntentId);
    } catch (e) {
      await audit(prisma, {
        userId: body.userId, actor: 'user', eventType: 'voice.capture_failed',
        payload: { orderId: body.orderId, err: (e as Error).message },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(502).send({ error: 'stripe_capture_failed' });
    }

    const succeeded = (captured as { status?: string }).status === 'succeeded';
    const final = await prisma.payment.update({
      where: { id: updated.id },
      data: succeeded
        ? { status: 'SUCCEEDED', capturedAt: new Date() }
        : { status: 'FAILED' },
    });

    await audit(prisma, {
      userId: body.userId, actor: 'user',
      eventType: succeeded ? 'voice.payment_captured' : 'voice.payment_failed',
      payload: { orderId: body.orderId, paymentId: final.id, intentStatus: (captured as { status?: string }).status },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send({
      ok: succeeded,
      paymentId: final.id,
      status: final.status,
      voicePinVerified: true,
      receiptUrl: succeeded ? `/api/receipts/${final.id}` : null,
      ttsConfirmation: succeeded
        ? `Pago de ${(final.amountCents / 100).toFixed(2)} ${final.currency} confirmado.`
        : 'No se pudo capturar el pago.',
    });
  });
}

export const __test = { failureCounts };
