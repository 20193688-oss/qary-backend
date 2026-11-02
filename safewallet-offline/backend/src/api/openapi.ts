import { ROUTES } from './routes.js';
import { errorSchema } from './schemas.js';

export function buildOpenApi(): Record<string, any> {
  const paths: Record<string, any> = {};
  for (const r of ROUTES) {
    const params: any[] = [];
    if (r.params) for (const [name, schema] of Object.entries((r.params as any).properties)) params.push({ name, in: 'path', required: true, schema });
    if (r.query) for (const [name, schema] of Object.entries((r.query as any).properties)) params.push({ name, in: 'query', required: ((r.query as any).required ?? []).includes(name), schema });
    const op: Record<string, any> = {
      summary: r.summary, tags: [r.tag], operationId: `${r.method}_${r.path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.body } } } } : {}),
      responses: {
        [String(r.status ?? 200)]: { description: 'OK', content: { 'application/json': { schema: r.ok } } },
        '400': { description: 'Solicitud inválida', content: { 'application/json': { schema: errorSchema } } },
        ...(r.public ? {} : { '401': { description: 'API key ausente o inválida', content: { 'application/json': { schema: errorSchema } } }, '403': { description: 'Plan insuficiente o acción prohibida', content: { 'application/json': { schema: errorSchema } } }, '429': { description: 'Rate limit', content: { 'application/json': { schema: errorSchema } } } }),
      },
      ...(r.public ? { security: [] } : { security: [{ ApiKey: [] }] }),
      ...(r.feature ? { 'x-required-plan-feature': r.feature } : {}),
      ...(r.admin ? { 'x-admin-only': true } : {}),
    };
    (paths[r.path] ??= {})[r.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SafeWallet Offline API', version: '0.1.0', description: 'Capa de seguridad B2B: tokenización, pagos offline, Protocolo Escudo, conciliación.', license: { name: 'Propietaria — ver LICENSE', url: 'https://example.invalid/LICENSE' } },
    servers: [{ url: 'http://localhost:3000' }],
    components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
    paths,
  };
}
