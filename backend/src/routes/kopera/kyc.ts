import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { audit } from '../../lib/audit.js';

export async function registerKycRoutes(app: FastifyInstance, prisma: PrismaClient) {

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

    const kyc = await prisma.kycProfile.upsert({
      where: { userId: req.auth!.userId },
      update: {
        documentType: body.documentType as any,
        documentNumber: body.documentNumber,
        documentCountry: body.documentCountry.toUpperCase(),
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
        nationality: body.nationality?.toUpperCase(),
        address: body.address as object ?? undefined,
        status: 'IN_REVIEW',
      },
      create: {
        userId: req.auth!.userId,
        documentType: body.documentType as any,
        documentNumber: body.documentNumber,
        documentCountry: body.documentCountry.toUpperCase(),
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
        nationality: body.nationality?.toUpperCase(),
        address: body.address as object,
        status: 'IN_REVIEW',
      },
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'kyc.started',
      payload: { kycId: kyc.id, documentType: body.documentType },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send({
      id: kyc.id,
      status: kyc.status,
      documentType: kyc.documentType,
      documentCountry: kyc.documentCountry,
    });
  });

  app.get('/api/kyc/status', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const kyc = await prisma.kycProfile.findUnique({ where: { userId: req.auth!.userId } });
    if (!kyc) return reply.code(404).send({ error: 'kyc_not_started' });
    return {
      id: kyc.id,
      status: kyc.status,
      documentType: kyc.documentType,
      documentCountry: kyc.documentCountry,
      verifiedAt: kyc.verifiedAt,
      riskScore: kyc.riskScore,
      pepCheck: kyc.pepCheck,
      sanctionsCheck: kyc.sanctionsCheck,
    };
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

    // Auto-validate business via agent chain
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
