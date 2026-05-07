import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Realtime } from '../lib/realtime.js';

interface Deps { realtime: Realtime }

const Body = z.object({
  driverId: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().optional(),
  speedKmh: z.number().optional(),
  ts: z.number().optional(),
  vehicleType: z.string().optional(),
  available: z.boolean().optional(),
});

export async function registerLocationsRoutes(app: FastifyInstance, deps: Deps) {
  // Recibe posiciones de drivers y las difunde por Socket.IO.
  // Permite usarse como webhook desde un simulador o desde la app del conductor.
  app.post('/api/locations', async (req, reply) => {
    const body = Body.parse(req.body);
    const ts = body.ts ?? Date.now();
    deps.realtime.broadcastDriverPosition({ ...body, ts });
    app.log.debug({ msg: 'location.broadcast', ...body, ts });
    return reply.send({ ok: true, ts });
  });
}
