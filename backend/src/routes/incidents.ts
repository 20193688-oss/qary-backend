import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// PR 8 lo cablea contra Prisma + media storage.
export async function registerIncidentsRoutes(app: FastifyInstance) {
  app.post('/api/incidents', async (req, reply) => {
    const body = z
      .object({
        orderId: z.string().optional(),
        userId: z.string(),
        type: z.enum(['SAFETY', 'PAYMENT', 'SERVICE', 'OTHER']),
        description: z.string().min(1),
        media: z.array(z.string().url()).optional(),
      })
      .parse(req.body);
    app.log.info({ msg: 'incident.reported', ...body });
    return reply.send({ ok: true, id: 'stub-incident-id' });
  });
}
