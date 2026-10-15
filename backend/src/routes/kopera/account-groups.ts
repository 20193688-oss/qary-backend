import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AccountGroupService } from '../../kopera/services/account-group.js';

export async function registerAccountGroupRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new AccountGroupService(prisma);

  const createSchema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    groupType: z.enum(['PERSONAL', 'BUSINESS', 'FAMILY', 'TEAM']),
  });

  const updateSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
  });

  const addMemberSchema = z.object({
    accountId: z.string().min(1),
    role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional(),
  });

  app.get('/api/account-groups/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getGroupAnalytics(req.auth!.userId);
  });

  app.get('/api/account-groups/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getGroups(req.auth!.userId);
  });

  app.post('/api/account-groups/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    try {
      const group = await svc.createGroup(req.auth!.userId, data);
      reply.status(201);
      return group;
    } catch (e: any) {
      if (e.message === 'group_name_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-groups/:id/update', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = updateSchema.parse(req.body);
    try {
      return await svc.updateGroup(req.auth!.userId, id, data);
    } catch (e: any) {
      if (e.message === 'group_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/account-groups/:id/add-member', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = addMemberSchema.parse(req.body);
    try {
      const member = await svc.addMember(req.auth!.userId, id, data);
      reply.status(201);
      return member;
    } catch (e: any) {
      if (e.message === 'group_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'member_already_exists') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/account-groups/:groupId/members/:memberId', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { groupId, memberId } = req.params as { groupId: string; memberId: string };
    try {
      return await svc.removeMember(req.auth!.userId, groupId, memberId);
    } catch (e: any) {
      if (e.message === 'group_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'member_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/account-groups/:id/members', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getMembers(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'group_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/account-groups/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.deleteGroup(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'group_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/account-groups/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getGroup(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'group_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
