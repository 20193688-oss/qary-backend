import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ComplianceDocumentService } from '../../kopera/services/compliance-document.js';

export async function registerComplianceDocumentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new ComplianceDocumentService(prisma);

  const createSchema = z.object({
    documentType: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    jurisdiction: z.string().min(1),
    effectiveDate: z.string().min(1),
  });

  app.get('/api/compliance-documents/analytics', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getDocumentAnalytics(req.auth!.userId);
  });

  app.get('/api/compliance-documents/list', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getDocuments(req.auth!.userId);
  });

  app.post('/api/compliance-documents/create', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    const d = await svc.createDocument(req.auth!.userId, data);
    reply.status(201);
    return d;
  });

  app.post('/api/compliance-documents/:id/submit', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.submitForReview(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'document_not_draft') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/compliance-documents/:id/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { approvedBy } = z.object({ approvedBy: z.string().min(1) }).parse(req.body);
    try {
      return await svc.approveDocument(req.auth!.userId, id, approvedBy);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'document_not_in_review') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.post('/api/compliance-documents/:id/archive', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.archiveDocument(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      if (e.message === 'document_not_approved') { reply.status(400); return { error: e.message }; }
      throw e;
    }
  });

  app.get('/api/compliance-documents/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.getDocument(req.auth!.userId, id);
    } catch (e: any) {
      if (e.message === 'document_not_found') { reply.status(404); return { error: e.message }; }
      throw e;
    }
  });
}
