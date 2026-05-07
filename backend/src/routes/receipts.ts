import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { hmacSign } from '../lib/crypto.js';

interface Deps {
  prisma: PrismaClient;
}

function buildReceiptPayload(p: {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
  status: string;
  capturedAt: Date | null;
  voicePinVerified: boolean;
  order: { userId: string; pickup: unknown; dropoff: unknown };
}) {
  return {
    receiptId: p.id,
    orderId: p.orderId,
    userId: p.order.userId,
    amount: { cents: p.amountCents, currency: p.currency },
    status: p.status,
    capturedAt: p.capturedAt?.toISOString() ?? null,
    voicePinVerified: p.voicePinVerified,
    pickup: p.order.pickup,
    dropoff: p.order.dropoff,
    issuedAt: new Date().toISOString(),
  };
}

function renderHtml(data: ReturnType<typeof buildReceiptPayload>, sig: string): string {
  const fmt = (cents: number, cur: string) => `${cur} ${(cents / 100).toFixed(2)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Recibo ${data.receiptId}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:24px auto;padding:0 16px;color:#0D0B2E}
h1{font-size:20px;margin:0 0 4px}.muted{color:#6B6B8A;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:16px}
td{padding:8px 0;border-bottom:1px solid #EEEEF8;vertical-align:top}
.total{font-size:22px;font-weight:800}.sig{margin-top:24px;font:11px/1.4 ui-monospace,monospace;word-break:break-all;color:#6B6B8A}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;background:#E8F8F0;color:#00723C}
</style></head><body>
<h1>QARY · Recibo</h1>
<div class="muted">Emitido ${data.issuedAt}</div>
<div style="margin-top:8px"><span class="badge">${data.status}</span></div>
<table>
  <tr><td>Recibo</td><td><b>${data.receiptId}</b></td></tr>
  <tr><td>Pedido</td><td>${data.orderId}</td></tr>
  <tr><td>Capturado</td><td>${data.capturedAt ?? '—'}</td></tr>
  <tr><td>PIN/voz verificado</td><td>${data.voicePinVerified ? 'sí' : 'no'}</td></tr>
  <tr><td>Total</td><td class="total">${fmt(data.amount.cents, data.amount.currency)}</td></tr>
</table>
<div class="sig">HMAC-SHA256: ${sig}</div>
</body></html>`;
}

export async function registerReceiptsRoutes(app: FastifyInstance, deps: Deps) {
  const { prisma } = deps;

  app.get('/api/receipts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const accept = (req.headers.accept ?? '').toLowerCase();
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { order: true },
    });
    if (!payment) return reply.code(404).send({ error: 'not_found' });
    if (payment.status !== 'SUCCEEDED') return reply.code(409).send({ error: 'not_captured_yet' });

    const data = buildReceiptPayload(payment);
    const sig = hmacSign(JSON.stringify(data));

    if (accept.includes('text/html')) {
      return reply.type('text/html').send(renderHtml(data, sig));
    }
    return reply.send({ ...data, signature: sig });
  });
}
