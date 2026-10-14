import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { BusinessProfileService } from '../../kopera/services/business-profiles.js';
import { audit } from '../../lib/audit.js';

function serialize(p: any) {
  return {
    id: p.id,
    userId: p.userId,
    taxId: p.taxId,
    taxIdType: p.taxIdType,
    taxIdCountry: p.taxIdCountry,
    legalName: p.legalName,
    tradeName: p.tradeName,
    incorporationDate: p.incorporationDate,
    economicActivity: p.economicActivity,
    ciiu: p.ciiu,
    fiscalAddress: p.fiscalAddress,
    legalRepName: p.legalRepName,
    legalRepDocType: p.legalRepDocType,
    legalRepDocNumber: p.legalRepDocNumber,
    status: p.status,
    verifiedAt: p.verifiedAt,
    rejectedReason: p.rejectedReason,
    riskScore: p.riskScore,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function registerBusinessProfileRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new BusinessProfileService(prisma);

  app.post('/api/business-profile', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      taxId: z.string().min(1),
      taxIdType: z.string().min(1),
      taxIdCountry: z.string().length(2),
      legalName: z.string().optional(),
      tradeName: z.string().optional(),
      incorporationDate: z.string().datetime().optional(),
      economicActivity: z.string().optional(),
      ciiu: z.string().optional(),
      fiscalAddress: z.record(z.unknown()).optional(),
      legalRepName: z.string().optional(),
      legalRepDocType: z.string().optional(),
      legalRepDocNumber: z.string().optional(),
    }).parse(req.body);

    try {
      const profile = await svc.create(req.auth!.userId, {
        ...body,
        incorporationDate: body.incorporationDate ? new Date(body.incorporationDate) : undefined,
        fiscalAddress: body.fiscalAddress as any,
      });

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'business_profile.created',
        payload: { taxId: body.taxId, country: body.taxIdCountry },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.code(201).send(serialize(profile));
    } catch (e: any) {
      if (e.message === 'profile_already_exists') return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const profile = await svc.getByUser(req.auth!.userId);
    if (!profile) return reply.code(404).send({ error: 'not_found' });
    return serialize(profile);
  });

  app.patch('/api/business-profile', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      legalName: z.string().optional(),
      tradeName: z.string().optional(),
      economicActivity: z.string().optional(),
      ciiu: z.string().optional(),
      fiscalAddress: z.record(z.unknown()).optional(),
      legalRepName: z.string().optional(),
      legalRepDocType: z.string().optional(),
      legalRepDocNumber: z.string().optional(),
    }).parse(req.body);

    try {
      const profile = await svc.update(req.auth!.userId, body as any);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/completeness', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const result = await svc.getProfileCompleteness(req.auth!.userId);
      return result;
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/compliance-readiness', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getComplianceReadiness(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/due-diligence', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getDueDiligenceReport(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/verification-status', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const status = await svc.getVerificationStatus(req.auth!.userId);
      return status;
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/risk-profile', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getRiskProfile(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/onboarding-timeline', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getOnboardingTimeline(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/compliance-gap-analysis', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getComplianceGapAnalysis(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/document-expiry-tracker', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getDocumentExpiryTracker(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/health-score', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getBusinessHealthScore(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/operational-readiness', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getBusinessOperationalReadiness(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/regulatory-readiness', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getBusinessRegulatoryReadiness(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/business-profile/continuity-score', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      return await svc.getBusinessContinuityScore(req.auth!.userId);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/business-profile/screening', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      riskScore: z.number().min(0).max(100).optional(),
      reputationScore: z.number().min(0).max(100).optional(),
      complianceScore: z.number().min(0).max(100).optional(),
      screeningReport: z.record(z.unknown()).optional(),
    }).parse(req.body);

    try {
      const profile = await svc.runScreening(req.auth!.userId, body);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'business_profile.screening',
        payload: { riskScore: body.riskScore, complianceScore: body.complianceScore },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/business-profile/verify', { preHandler: [app.requireAuth] }, async (req, reply) => {
    try {
      const profile = await svc.verify(req.auth!.userId, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'business_profile.verified',
        payload: { profileId: profile.id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      if (e.message === 'already_verified') return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/business-profile/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      reason: z.string().min(1),
    }).parse(req.body);

    try {
      const profile = await svc.reject(req.auth!.userId, body.reason);
      return serialize(profile);
    } catch (e: any) {
      if (e.message === 'profile_not_found') return reply.code(404).send({ error: e.message });
      throw e;
    }
  });
}
