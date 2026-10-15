import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { TransactionMapService } from '../../kopera/services/transaction-map.js';

export async function registerTransactionMapRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new TransactionMapService(prisma);

  const locationSchema = z.object({
    transactionId: z.string().uuid(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    city: z.string().optional(),
    country: z.string().optional(),
    deviceId: z.string().optional(),
  });

  app.get('/api/transaction-map/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getGeoAnalytics(req.auth!.userId);
  });

  app.get('/api/transaction-map/locations', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getTransactionLocations(req.auth!.userId);
  });

  app.post('/api/transaction-map/record', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = locationSchema.parse(req.body);
    try {
      const location = await svc.recordLocation(req.auth!.userId, data.transactionId, data);
      reply.status(201);
      return location;
    } catch (e: any) {
      if (e.message === 'transaction_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.get('/api/transaction-map/:transactionId', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { transactionId } = req.params as { transactionId: string };
    try {
      return await svc.getLocationByTransaction(req.auth!.userId, transactionId);
    } catch (e: any) {
      if (e.message === 'location_not_found') {
        reply.status(404);
        return { error: e.message };
      }
      throw e;
    }
  });
}
