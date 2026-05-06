import 'dotenv/config';
import Fastify from 'fastify';
import { z } from 'zod';
import { IntentSchemas } from './intents.js';
import { preFilter } from './safety.js';

const PORT = Number(process.env.AGENT_PORT ?? 3100);
const MODEL = process.env.AGENT_MODEL ?? 'claude-haiku-4-5';

const app = Fastify({ logger: true });

// PR 6: este endpoint llamará a Anthropic SDK con tool-use para clasificar
// intent + slots y devolver una acción ejecutable. Por ahora es stub.
app.post('/agents/transcribe', async (req, reply) => {
  const body = z.object({ transcript: z.string().min(1), userId: z.string() }).parse(req.body);
  const filt = preFilter(body.transcript);
  if (!filt.ok) return reply.code(400).send({ error: filt.reason });
  return reply.send({
    model: MODEL,
    redacted: filt.redacted,
    classified: { intent: 'unknown', slots: {} },
    note: 'stub PR 6: cablear classifier con Claude tool-use',
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
  return reply.send({ ok: true, executed: false, intent: body.intent, note: 'stub PR 6' });
});

app.get('/health', async () => ({ ok: true, model: MODEL }));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`agents listening on :${PORT} (model ${MODEL})`);
});
