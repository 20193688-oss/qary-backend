import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// PR 3 implementará OTP+JWT real. Stubs por ahora.
export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/otp/request', async (req, reply) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    // TODO: enviar OTP via SendGrid sandbox y guardar en Redis con TTL
    return reply.send({ ok: true, debug: `otp para ${body.email} (stub PR 3)` });
  });

  app.post('/api/auth/otp/verify', async (req, reply) => {
    const body = z.object({ email: z.string().email(), code: z.string().length(4) }).parse(req.body);
    // TODO PR 3: verificar contra Redis y emitir JWT
    return reply.send({ ok: true, accessToken: 'stub.jwt.token', user: { email: body.email } });
  });
}
