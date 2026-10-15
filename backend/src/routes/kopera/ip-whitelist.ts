import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { IpWhitelistService } from '../../kopera/services/ip-whitelist.js';

export async function registerIpWhitelistRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new IpWhitelistService(prisma);

  const addSchema = z.object({
    ipAddress: z.string().min(7).max(45),
    label: z.string().max(100).optional(),
    expiresAt: z.string().transform((s) => new Date(s)).optional(),
  });

  const toggleSchema = z.object({ active: z.boolean() });
  const checkSchema = z.object({ ipAddress: z.string().min(7).max(45) });

  app.get('/api/ip-whitelist/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getIpWhitelistAnalytics(req.auth!.userId);
  });

  app.get('/api/ip-whitelist/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getIps(req.auth!.userId);
  });

  app.post('/api/ip-whitelist/add', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = addSchema.parse(req.body);
    try {
      const entry = await svc.addIp(req.auth!.userId, data);
      reply.status(201);
      return entry;
    } catch (e: any) {
      if (e.message === 'max_ips_reached' || e.message === 'ip_already_whitelisted') {
        reply.status(400);
        return { error: e.message };
      }
      throw e;
    }
  });

  app.post('/api/ip-whitelist/check', { preHandler: [app.requireAuth] }, async (req) => {
    const data = checkSchema.parse(req.body);
    return svc.checkIp(req.auth!.userId, data.ipAddress);
  });

  app.post('/api/ip-whitelist/:id/toggle', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = toggleSchema.parse(req.body);
    try {
      return await svc.toggleIp(req.auth!.userId, id, data.active);
    } catch (e: any) {
      if (e.message === 'ip_entry_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/ip-whitelist/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.removeIp(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'ip_entry_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
