import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; email: string; role: string };
  }
}

export async function authPlugin(app: FastifyInstance) {
  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return reply.code(401).send({ error: 'missing_token' });
    try {
      const payload = verifyAccessToken(h.slice(7));
      req.auth = { userId: payload.sub, email: payload.email, role: payload.role };
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
