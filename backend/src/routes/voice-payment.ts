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
  transactionId: z.string().min(1),
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
        payload: { transactionId: body.transactionId }, requestId: String(req.id), ip: req.ip,
      });
      return reply.code(401).send({ error: 'invalid_pin' });
    }

    const transaction = await prisma.transaction.findUnique({
      where: { id: body.transactionId },
      include: { gatewayPayment: true },
    });
    if (!transaction) return reply.code(404).send({ error: 'transaction_not_found' });
    if (transaction.userId !== body.userId)
      return reply.code(403).send({ error: 'forbidden' });
    if (!transaction.gatewayPayment) return reply.code(404).send({ error: 'no_gateway_payment' });
    if (transaction.gatewayPayment.status === 'CAPTURED')
      return reply.code(409).send({ error: 'already_captured' });

    const processorRef = transaction.gatewayPayment.processorRef;
    if (!processorRef) return reply.code(400).send({ error: 'no_processor_ref' });

    let captured;
    try {
      captured = await stripe.paymentIntents.capture(processorRef);
    } catch (e) {
      await audit(prisma, {
        userId: body.userId, actor: 'user', eventType: 'voice.capture_failed',
        payload: { transactionId: body.transactionId, err: (e as Error).message },
        requestId: String(req.id), ip: req.ip,
      });
      return reply.code(502).send({ error: 'stripe_capture_failed' });
    }

    const succeeded = (captured as { status?: string }).status === 'succeeded';

    await prisma.gatewayPayment.update({
      where: { transactionId: transaction.id },
      data: succeeded
        ? { status: 'CAPTURED', settledAt: new Date() }
        : { status: 'FAILED', errorMessage: 'capture_failed' },
    });

    const updatedTx = await prisma.transaction.update({
      where: { id: transaction.id },
      data: succeeded
        ? { status: 'COMPLETED', processedAt: new Date() }
        : { status: 'FAILED', failedReason: 'capture_failed' },
    });

    await audit(prisma, {
      userId: body.userId, actor: 'user',
      eventType: succeeded ? 'voice.payment_captured' : 'voice.payment_failed',
      payload: { transactionId: updatedTx.id, intentStatus: (captured as { status?: string }).status },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.send({
      ok: succeeded,
      transactionId: updatedTx.id,
      status: updatedTx.status,
      voicePinVerified: true,
      receiptUrl: succeeded ? `/api/receipts/${transaction.gatewayPayment!.id}` : null,
      ttsConfirmation: succeeded
        ? `Pago de ${(Number(updatedTx.amount) / 100).toFixed(2)} ${updatedTx.currency} confirmado.`
        : 'No se pudo capturar el pago.',
    });
  });
}

export const __test = { failureCounts };
