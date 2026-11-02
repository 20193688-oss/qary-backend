import Fastify, { type FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import { AppError } from '../util/errors.js';
import { PLAN_FEATURES, PLAN_RATE_LIMIT_PER_MIN, tenantByKey } from '../services/tenants.js';
import { ROUTES } from './routes.js';
import { buildOpenApi } from './openapi.js';

export async function buildApp(ctx: Ctx, _opts: Record<string, never> | { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log,
    bodyLimit: 1_000_000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: false, strict: false } },
  });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try { done(null, body === '' ? {} : JSON.parse(body as string)); } catch { done(new AppError('invalid_json', 400, 'JSON inválido')); }
  });

  app.setErrorHandler((err: Error & { validation?: unknown; statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) {
      (err.status >= 500 ? req.log.error : req.log.warn).call(req.log, { code: err.code, details: err.details, url: req.url }, err.message);
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      req.log.warn({ validation: err.validation, url: req.url }, 'solicitud inválida');
      return reply.status(400).send({ error: { code: 'validation_error', message: err.message, details: err.validation } });
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error({ err, url: req.url }, 'error interno');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Error interno; el incidente quedó registrado.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'ruta inexistente' } }));

  const openapi = buildOpenApi();
  app.get('/openapi.json', async () => openapi);

  for (const r of ROUTES) {
    const url = r.path.replace(/\{(\w+)\}/g, ':$1');
    app.route({
      method: r.method.toUpperCase() as 'GET' | 'POST' | 'PUT', url,
      schema: { ...(r.body ? { body: r.body } : {}), ...(r.params ? { params: r.params } : {}), ...(r.query ? { querystring: r.query } : {}) },
      handler: async (req, reply) => {
        let tenant = undefined as never as import('../types.js').Tenant;
        if (!r.public) {
          const key = req.headers['x-api-key'];
          if (typeof key !== 'string' || !key) throw new AppError('unauthorized', 401, 'falta el header x-api-key');
          const t = await tenantByKey(ctx, key);
          if (!t) throw new AppError('unauthorized', 401, 'API key inválida');
          tenant = t;
          if (r.admin && !t.admin) throw new AppError('forbidden', 403, 'solo administración');
          if (r.feature && !PLAN_FEATURES[t.plan].includes(r.feature)) throw new AppError('plan_required', 403, `tu plan '${t.plan}' no incluye '${r.feature}'`, { plan: t.plan, feature: r.feature });
          const minute = Math.floor(ctx.now() / 60_000);
          const n = await ctx.kv.incr(`rl:${t.id}:${minute}`, 90);
          if (n > PLAN_RATE_LIMIT_PER_MIN[t.plan]) {
            reply.header('retry-after', '30');
            throw new AppError('rate_limited', 429, 'límite de peticiones excedido');
          }
        }
        const out = await r.handler({ ctx, tenant, body: req.body, params: req.params, query: req.query, ip: req.ip, headers: req.headers, rawBody: (req as unknown as { rawBody?: string }).rawBody });
        return reply.status(r.status ?? 200).send(out);
      },
    });
  }
  return app;
}
