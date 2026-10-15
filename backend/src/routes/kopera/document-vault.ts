import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { DocumentVaultService } from '../../kopera/services/document-vault.js';

export async function registerDocumentVaultRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new DocumentVaultService(prisma);

  const storeSchema = z.object({
    documentType: z.string().min(1).max(100),
    fileName: z.string().min(1).max(255),
    fileSize: z.number().int().min(1),
    mimeType: z.string().min(1).max(100),
    storageUrl: z.string().url(),
    category: z.string().max(50).optional(),
    expiresAt: z.string().transform((s) => new Date(s)).optional(),
  });

  app.get('/api/document-vault/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    const analytics = await svc.getVaultAnalytics(req.auth!.userId);
    return { ...analytics, totalSize: analytics.totalSize.toString() };
  });

  app.get('/api/document-vault/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getDocuments(req.auth!.userId);
  });

  app.post('/api/document-vault/store', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = storeSchema.parse(req.body);
    const doc = await svc.storeDocument(req.auth!.userId, data);
    reply.status(201);
    return doc;
  });

  app.get('/api/document-vault/category/:category', { preHandler: [app.requireAuth] }, async (req) => {
    const { category } = req.params as { category: string };
    return svc.getDocumentsByCategory(req.auth!.userId, category);
  });

  app.post('/api/document-vault/:id/archive', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.archiveDocument(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'document_already_archived') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/document-vault/:id/integrity', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.verifyIntegrity(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.delete('/api/document-vault/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.deleteDocument(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/document-vault/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getDocument(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
