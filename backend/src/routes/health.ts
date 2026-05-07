import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));
  app.get('/version', async () => ({ name: 'qary-backend', version: '0.1.0' }));
}
