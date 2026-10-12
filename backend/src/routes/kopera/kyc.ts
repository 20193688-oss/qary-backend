import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit.js';
import { KycService } from '../../kopera/services/kyc.js';

export async function registerKycRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const kyc = new KycService(prisma);

  app.post('/api/kyc/start', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      documentType: z.enum(['DNI', 'PASSPORT', 'RUC', 'RFC', 'NIT', 'CIF', 'RUT', 'CNPJ', 'CPF', 'DRIVERS_LICENSE']),
      documentNumber: z.string().min(1).max(30),
      documentCountry: z.string().length(2),
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      dateOfBirth: z.string().optional(),
      nationality: z.string().length(2).optional(),
      address: z.object({
        street: z.string(),
        city: z.string(),
        state: z.string().optional(),
        postalCode: z.string(),
        country: z.string().length(2),
      }).optional(),
    }).parse(req.body);

    const profile = await kyc.start(req.auth!.userId, {
      documentType: body.documentType,
      documentNumber: body.documentNumber,
      documentCountry: body.documentCountry,
      firstName: body.firstName,
      lastName: body.lastName,
      dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
      nationality: body.nationality,
      address: body.address as Prisma.InputJsonValue ?? undefined,
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'kyc.started',
      payload: { kycId: profile.id, documentType: body.documentType },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send({
      id: profile.id,
      status: profile.status,
      documentType: profile.documentType,
      documentCountry: profile.documentCountry,
    });
  });

  app.get('/api/kyc/status', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const profile = await kyc.getByUser(req.auth!.userId);
    if (!profile) return reply.code(404).send({ error: 'kyc_not_started' });
    return {
      id: profile.id,
      status: profile.status,
      documentType: profile.documentType,
      documentCountry: profile.documentCountry,
      verifiedAt: profile.verifiedAt,
      riskScore: profile.riskScore,
      pepCheck: profile.pepCheck,
      sanctionsCheck: profile.sanctionsCheck,
    };
  });

  app.get('/api/kyc/all', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; status?: string };
    const list = await kyc.listAll({
      status: query.status,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return list.map((p: any) => ({
      id: p.id,
      userId: p.userId,
      status: p.status,
      documentType: p.documentType,
      documentCountry: p.documentCountry,
      firstName: p.firstName,
      lastName: p.lastName,
      verifiedAt: p.verifiedAt,
      riskScore: p.riskScore,
      createdAt: p.createdAt,
    }));
  });

  app.post('/api/kyc/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const profile = await kyc.approve(req.auth!.userId, req.auth!.userId);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'admin', eventType: 'kyc.approved',
        payload: { kycId: profile.id },
        requestId: String(req.id), ip: req.ip,
      });

      return {
        id: profile.id,
        status: profile.status,
        verifiedAt: profile.verifiedAt,
        pepCheck: profile.pepCheck,
        sanctionsCheck: profile.sanctionsCheck,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'kyc_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'already_approved') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/kyc/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      reason: z.string().min(1).max(500),
    }).parse(req.body);

    try {
      const profile = await kyc.reject(req.auth!.userId, body.reason, req.auth!.userId);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'admin', eventType: 'kyc.rejected',
        payload: { kycId: profile.id, reason: body.reason },
        requestId: String(req.id), ip: req.ip,
      });

      return {
        id: profile.id,
        status: profile.status,
        rejectedReason: profile.rejectedReason,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'kyc_not_found') return reply.code(404).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/kyc/documents', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      documentFrontUrl: z.string().url().optional(),
      documentBackUrl: z.string().url().optional(),
      selfieUrl: z.string().url().optional(),
      livenessImageUrl: z.string().url().optional(),
    }).parse(req.body);

    try {
      const profile = await kyc.uploadDocumentUrls(req.auth!.userId, body);
      return {
        id: profile.id,
        documentFrontUrl: profile.documentFrontUrl,
        documentBackUrl: profile.documentBackUrl,
        selfieUrl: profile.selfieUrl,
        livenessImageUrl: profile.livenessImageUrl,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'kyc_not_found') return reply.code(404).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/kyc/risk-score', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      riskScore: z.number().min(0).max(100),
    }).parse(req.body);

    try {
      const profile = await kyc.setRiskScore(req.auth!.userId, body.riskScore);
      return { id: profile.id, riskScore: profile.riskScore };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'kyc_not_found') return reply.code(404).send({ error: msg });
      throw err;
    }
  });

  // Business (KYB) registration
  app.post('/api/kyb/register', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      taxId: z.string().min(1).max(20),
      taxIdType: z.enum(['RUC', 'RFC', 'NIT', 'CIF', 'RUT', 'CNPJ']),
      taxIdCountry: z.string().length(2),
      tradeName: z.string().optional(),
      legalRepName: z.string().optional(),
      legalRepDocType: z.string().optional(),
      legalRepDocNumber: z.string().optional(),
    }).parse(req.body);

    const business = await prisma.businessProfile.upsert({
      where: { userId: req.auth!.userId },
      update: {
        taxId: body.taxId,
        taxIdType: body.taxIdType,
        taxIdCountry: body.taxIdCountry.toUpperCase(),
        tradeName: body.tradeName,
        legalRepName: body.legalRepName,
        legalRepDocType: body.legalRepDocType,
        legalRepDocNumber: body.legalRepDocNumber,
        status: 'IN_REVIEW',
      },
      create: {
        userId: req.auth!.userId,
        taxId: body.taxId,
        taxIdType: body.taxIdType,
        taxIdCountry: body.taxIdCountry.toUpperCase(),
        tradeName: body.tradeName,
        legalRepName: body.legalRepName,
        legalRepDocType: body.legalRepDocType,
        legalRepDocNumber: body.legalRepDocNumber,
        status: 'IN_REVIEW',
      },
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'kyb.registered',
      payload: { businessId: business.id, taxId: body.taxId, country: body.taxIdCountry },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send({
      id: business.id,
      taxId: business.taxId,
      legalName: business.legalName,
      status: business.status,
    });
  });

  app.post('/api/kyb/approve', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      userId: z.string().min(1),
    }).parse(req.body);

    const biz = await prisma.businessProfile.findUnique({ where: { userId: body.userId } });
    if (!biz) return reply.code(404).send({ error: 'kyb_not_found' });
    if (biz.status === 'APPROVED') return reply.code(400).send({ error: 'already_approved' });

    const updated = await prisma.businessProfile.update({
      where: { userId: body.userId },
      data: { status: 'APPROVED', verifiedAt: new Date() },
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'admin', eventType: 'kyb.approved',
      payload: { businessId: updated.id, targetUserId: body.userId },
      requestId: String(req.id), ip: req.ip,
    });

    return { id: updated.id, status: updated.status, verifiedAt: updated.verifiedAt };
  });

  app.post('/api/kyb/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      userId: z.string().min(1),
      reason: z.string().min(1).max(500),
    }).parse(req.body);

    const biz = await prisma.businessProfile.findUnique({ where: { userId: body.userId } });
    if (!biz) return reply.code(404).send({ error: 'kyb_not_found' });

    const updated = await prisma.businessProfile.update({
      where: { userId: body.userId },
      data: { status: 'REJECTED', rejectedReason: body.reason },
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'admin', eventType: 'kyb.rejected',
      payload: { businessId: updated.id, targetUserId: body.userId, reason: body.reason },
      requestId: String(req.id), ip: req.ip,
    });

    return { id: updated.id, status: updated.status, rejectedReason: updated.rejectedReason };
  });

  app.get('/api/kyb/status', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const biz = await prisma.businessProfile.findUnique({ where: { userId: req.auth!.userId } });
    if (!biz) return reply.code(404).send({ error: 'kyb_not_started' });
    return {
      id: biz.id,
      taxId: biz.taxId,
      legalName: biz.legalName,
      tradeName: biz.tradeName,
      status: biz.status,
      habidomStatus: biz.habidomStatus,
      riskScore: biz.riskScore,
      reputationScore: biz.reputationScore,
      complianceScore: biz.complianceScore,
      verifiedAt: biz.verifiedAt,
    };
  });
}
