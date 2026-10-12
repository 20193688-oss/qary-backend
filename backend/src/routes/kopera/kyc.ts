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
