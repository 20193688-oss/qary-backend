import type { FastifyInstance } from 'fastify';

// Esqueleto. PR 4 cablea creación real + emisión Socket.IO en order.created.
export async function registerOrdersRoutes(app: FastifyInstance) {
  app.get('/api/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send({ id, status: 'PENDING', stub: true });
  });
}
