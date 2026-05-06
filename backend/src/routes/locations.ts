import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// PR 4 conectará esto al pubsub Redis y a Socket.IO.
export async function registerLocationsRoutes(app: FastifyInstance) {
  app.post('/api/locations', async (req, reply) => {
    const body = z
      .object({
        driverId: z.string(),
        lat: z.number(),
        lng: z.number(),
        ts: z.number().optional(),
      })
      .parse(req.body);
    app.log.info({ msg: 'location.update', ...body });
    return reply.send({ ok: true });
  });
}
