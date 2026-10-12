import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { hmacSign } from '../lib/crypto.js';

interface Deps {
  prisma: PrismaClient;
}

function buildReceiptPayload(gp: {
  id: string;
  amount: bigint;
  currency: string;
  status: string;
  settledAt: Date | null;
  transaction: { userId: string; description: string | null; reference: string | null };
}) {
  return {
    receiptId: gp.id,
    transactionRef: gp.transaction.reference,
    userId: gp.transaction.userId,
    amount: { cents: Number(gp.amount), currency: gp.currency },
    status: gp.status,
    settledAt: gp.settledAt?.toISOString() ?? null,
    description: gp.transaction.description,
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
<h1>KOPERA · Recibo</h1>
<div class="muted">Emitido ${data.issuedAt}</div>
<div style="margin-top:8px"><span class="badge">${data.status}</span></div>
<table>
  <tr><td>Recibo</td><td><b>${data.receiptId}</b></td></tr>
  <tr><td>Referencia</td><td>${data.transactionRef ?? '—'}</td></tr>
  <tr><td>Liquidado</td><td>${data.settledAt ?? '—'}</td></tr>
  <tr><td>Descripción</td><td>${data.description ?? '—'}</td></tr>
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
    const gp = await prisma.gatewayPayment.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!gp) return reply.code(404).send({ error: 'not_found' });
    if (gp.status !== 'CAPTURED') return reply.code(409).send({ error: 'not_captured_yet' });

    const data = buildReceiptPayload(gp);
    const sig = hmacSign(JSON.stringify(data));

    if (accept.includes('text/html')) {
      return reply.type('text/html').send(renderHtml(data, sig));
    }
    return reply.send({ ...data, signature: sig });
  });
}
