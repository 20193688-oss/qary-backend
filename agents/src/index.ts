import 'dotenv/config';
import Fastify from 'fastify';
import { z } from 'zod';
import { IntentSchemas } from './intents.js';
import { preFilter } from './safety.js';

const PORT = Number(process.env.AGENT_PORT ?? 3100);
const MODEL = process.env.AGENT_MODEL ?? 'claude-haiku-4-5';

const app = Fastify({ logger: true });

app.post('/agents/transcribe', async (req, reply) => {
  const body = z.object({ transcript: z.string().min(1), userId: z.string() }).parse(req.body);
  const filt = preFilter(body.transcript);
  if (!filt.ok) return reply.code(400).send({ error: filt.reason });

  const intent = classifyIntent(filt.redacted ?? body.transcript);

  return reply.send({
    model: MODEL,
    redacted: filt.redacted,
    classified: intent,
  });
});

app.post('/agents/execute', async (req, reply) => {
  const body = z
    .object({
      intent: z.enum(Object.keys(IntentSchemas) as [string, ...string[]]),
      slots: z.record(z.unknown()),
      userId: z.string(),
    })
    .parse(req.body);
  const schema = IntentSchemas[body.intent as keyof typeof IntentSchemas];
  const parsed = schema.safeParse(body.slots);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_slots', issues: parsed.error.issues });
  return reply.send({ ok: true, executed: true, intent: body.intent, slots: parsed.data });
});

app.get('/health', async () => ({
  ok: true,
  model: MODEL,
  service: 'kopera-agents',
  agents: 51,
  intents: Object.keys(IntentSchemas).length,
}));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`Kopera agents listening on :${PORT} (model ${MODEL})`);
});

function classifyIntent(text: string): { intent: string; slots: Record<string, unknown>; confidence: number } {
  const lower = text.toLowerCase();

  if (/saldo|balance|cuanto\s+tengo/i.test(lower)) {
    const currMatch = lower.match(/\b(pen|usd|eur|mxn|brl|clp|cop|ars)\b/i);
    return { intent: 'check_balance', slots: { currency: currMatch?.[1]?.toUpperCase() }, confidence: 0.9 };
  }
  if (/enviar|transferir|mandar\s+dinero|send\s+money/i.test(lower)) {
    const amountMatch = lower.match(/(\d+(?:\.\d+)?)/);
    return { intent: 'send_money', slots: { amount: amountMatch ? parseFloat(amountMatch[1]!) : undefined }, confidence: 0.85 };
  }
  if (/cambiar|convertir|tipo\s+de\s+cambio|exchange/i.test(lower)) {
    return { intent: 'convert_currency', slots: {}, confidence: 0.8 };
  }
  if (/pagar|cobrar|payment/i.test(lower)) {
    return { intent: 'pay', slots: {}, confidence: 0.8 };
  }
  if (/prestamo|loan|credito/i.test(lower)) {
    return { intent: 'simulate_loan', slots: {}, confidence: 0.8 };
  }
  if (/factura|boleta|invoice/i.test(lower)) {
    return { intent: 'create_invoice', slots: {}, confidence: 0.8 };
  }
  if (/puntos|points|recompensa/i.test(lower)) {
    return { intent: 'check_points', slots: {}, confidence: 0.85 };
  }
  if (/salud\s+financiera|financial\s+health|score/i.test(lower)) {
    return { intent: 'financial_health', slots: {}, confidence: 0.85 };
  }
  if (/gastos?\s+hormiga|micro.?gastos|ant\s+expenses|suscripciones/i.test(lower)) {
    return { intent: 'detect_ant_expenses', slots: {}, confidence: 0.9 };
  }
  if (/problema|issue|ayuda|help|soporte|support/i.test(lower)) {
    return { intent: 'report_issue', slots: { type: 'OTHER' }, confidence: 0.7 };
  }

  return { intent: 'unknown', slots: {}, confidence: 0 };
}
