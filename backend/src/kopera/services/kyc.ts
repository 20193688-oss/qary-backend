import type { PrismaClient, Prisma } from '@prisma/client';

export class KycService {
  constructor(private prisma: PrismaClient) {}

  async start(userId: string, data: {
    documentType: string;
    documentNumber: string;
    documentCountry: string;
    firstName: string;
    lastName: string;
    dateOfBirth?: Date;
    nationality?: string;
    address?: Prisma.InputJsonValue;
  }) {
    return this.prisma.kycProfile.upsert({
      where: { userId },
      update: {
        documentType: data.documentType as any,
        documentNumber: data.documentNumber,
        documentCountry: data.documentCountry.toUpperCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        dateOfBirth: data.dateOfBirth,
        nationality: data.nationality?.toUpperCase(),
        address: data.address,
        status: 'IN_REVIEW',
      },
      create: {
        userId,
        documentType: data.documentType as any,
        documentNumber: data.documentNumber,
        documentCountry: data.documentCountry.toUpperCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        dateOfBirth: data.dateOfBirth,
        nationality: data.nationality?.toUpperCase(),
        address: data.address,
        status: 'IN_REVIEW',
      },
    });
  }

  async getByUser(userId: string) {
    return this.prisma.kycProfile.findUnique({ where: { userId } });
  }

  async listAll(opts?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = {};
    if (opts?.status) where.status = opts.status;
    return this.prisma.kycProfile.findMany({
      where,
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async approve(userId: string, reviewedBy: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');
    if (profile.status === 'APPROVED') throw new Error('already_approved');

    return this.prisma.kycProfile.update({
      where: { userId },
      data: {
        status: 'APPROVED',
        verifiedAt: new Date(),
        reviewedBy,
        pepCheck: true,
        sanctionsCheck: true,
      },
    });
  }

  async reject(userId: string, reason: string, reviewedBy: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    return this.prisma.kycProfile.update({
      where: { userId },
      data: {
        status: 'REJECTED',
        rejectedReason: reason,
        reviewedBy,
      },
    });
  }

  async uploadDocumentUrls(userId: string, data: {
    documentFrontUrl?: string;
    documentBackUrl?: string;
    selfieUrl?: string;
    livenessImageUrl?: string;
  }) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    return this.prisma.kycProfile.update({
      where: { userId },
      data,
    });
  }

  async checkExpiry(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const expiryDays = 365;
    const verifiedDate = profile.verifiedAt;
    if (!verifiedDate || profile.status !== 'APPROVED') {
      return { expired: false, status: profile.status, verifiedAt: null, expiresAt: null, daysRemaining: null };
    }

    const expiresAt = new Date(verifiedDate.getTime() + expiryDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    return {
      expired: daysRemaining <= 0,
      status: profile.status,
      verifiedAt: verifiedDate,
      expiresAt,
      daysRemaining: Math.max(0, daysRemaining),
    };
  }

  async getVerificationProgress(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const steps = [
      { step: 'personal_info', completed: !!(profile.firstName && profile.lastName), description: 'First and last name' },
      { step: 'document_type', completed: !!profile.documentType, description: 'Document type selected' },
      { step: 'document_number', completed: !!profile.documentNumber, description: 'Document number provided' },
      { step: 'document_front', completed: !!(profile as any).documentFrontUrl, description: 'Front of document uploaded' },
      { step: 'document_back', completed: !!(profile as any).documentBackUrl, description: 'Back of document uploaded' },
      { step: 'selfie', completed: !!(profile as any).selfieUrl, description: 'Selfie uploaded' },
      { step: 'liveness', completed: !!(profile as any).livenessImageUrl, description: 'Liveness check completed' },
      { step: 'review', completed: profile.status === 'APPROVED' || profile.status === 'REJECTED', description: 'Review completed' },
    ];

    const completedCount = steps.filter(s => s.completed).length;
    const progressPercent = Math.round((completedCount / steps.length) * 100);

    return {
      status: profile.status,
      progressPercent,
      completedSteps: completedCount,
      totalSteps: steps.length,
      steps,
    };
  }

  async getComplianceSummary(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) {
      return {
        kycStarted: false,
        status: null,
        documentComplete: false,
        identityVerified: false,
        riskScore: null,
        complianceReady: false,
        checksCompleted: { pep: false, sanctions: false },
        completionPercent: 0,
      };
    }

    const documentComplete = !!(profile.documentType && profile.documentNumber && (profile as any).documentFrontUrl);
    const identityVerified = profile.status === 'APPROVED' && !!profile.verifiedAt;
    const checksCompleted = {
      pep: profile.pepCheck ?? false,
      sanctions: profile.sanctionsCheck ?? false,
    };
    const complianceReady = identityVerified && checksCompleted.pep && checksCompleted.sanctions;

    const items = [
      !!profile.firstName,
      !!profile.documentType,
      !!profile.documentNumber,
      !!(profile as any).documentFrontUrl,
      !!(profile as any).selfieUrl,
      identityVerified,
      checksCompleted.pep,
      checksCompleted.sanctions,
    ];
    const completionPercent = Math.round((items.filter(Boolean).length / items.length) * 100);

    return {
      kycStarted: true,
      status: profile.status,
      documentComplete,
      identityVerified,
      riskScore: profile.riskScore,
      complianceReady,
      checksCompleted,
      completionPercent,
    };
  }

  async getRenewalReadiness(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) {
      return {
        kycExists: false,
        status: null,
        needsRenewal: false,
        renewalUrgency: 'none' as const,
        missingFields: ['all'],
        completionPercent: 0,
        daysUntilExpiry: null as number | null,
        recommendations: ['Start KYC verification'],
      };
    }

    const missingFields: string[] = [];
    if (!profile.firstName) missingFields.push('firstName');
    if (!profile.lastName) missingFields.push('lastName');
    if (!profile.documentType) missingFields.push('documentType');
    if (!profile.documentNumber) missingFields.push('documentNumber');
    if (!(profile as any).documentFrontUrl) missingFields.push('documentFrontUrl');
    if (!(profile as any).documentBackUrl) missingFields.push('documentBackUrl');
    if (!(profile as any).selfieUrl) missingFields.push('selfieUrl');
    if (!(profile as any).livenessImageUrl) missingFields.push('livenessImageUrl');

    const totalFields = 8;
    const completionPercent = Math.round(((totalFields - missingFields.length) / totalFields) * 100);

    let daysUntilExpiry: number | null = null;
    let needsRenewal = false;
    let renewalUrgency: 'none' | 'upcoming' | 'critical' | 'expired' = 'none';

    if (profile.status === 'APPROVED' && profile.verifiedAt) {
      const expiresAt = new Date(profile.verifiedAt.getTime() + 365 * 24 * 60 * 60 * 1000);
      daysUntilExpiry = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      if (daysUntilExpiry <= 0) { needsRenewal = true; renewalUrgency = 'expired'; }
      else if (daysUntilExpiry <= 30) { needsRenewal = true; renewalUrgency = 'critical'; }
      else if (daysUntilExpiry <= 90) { needsRenewal = true; renewalUrgency = 'upcoming'; }
    } else if (profile.status === 'REJECTED') {
      needsRenewal = true;
      renewalUrgency = 'critical';
    }

    const recommendations: string[] = [];
    if (profile.status === 'REJECTED') recommendations.push('Resubmit KYC with corrected information');
    if (renewalUrgency === 'expired') recommendations.push('KYC has expired, renewal required immediately');
    else if (renewalUrgency === 'critical') recommendations.push('KYC expires within 30 days, start renewal');
    else if (renewalUrgency === 'upcoming') recommendations.push('KYC expires within 90 days, plan renewal');
    if (missingFields.length > 0 && profile.status !== 'APPROVED') {
      recommendations.push(`Complete missing fields: ${missingFields.join(', ')}`);
    }
    if (!profile.pepCheck) recommendations.push('PEP check pending');
    if (!profile.sanctionsCheck) recommendations.push('Sanctions check pending');

    return {
      kycExists: true,
      status: profile.status,
      needsRenewal,
      renewalUrgency,
      missingFields,
      completionPercent,
      daysUntilExpiry,
      recommendations,
    };
  }

  async getOnboardingFunnel() {
    const profiles = await this.prisma.kycProfile.findMany({});

    const byStatus: Record<string, number> = {};
    const byDocumentType: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let approvedCount = 0;
    let rejectedCount = 0;
    let totalVerificationMs = 0;
    let verifiedWithTimeCount = 0;

    for (const p of profiles) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      if (p.documentType) byDocumentType[p.documentType] = (byDocumentType[p.documentType] ?? 0) + 1;
      if (p.documentCountry) byCountry[p.documentCountry] = (byCountry[p.documentCountry] ?? 0) + 1;

      if (p.status === 'APPROVED') {
        approvedCount++;
        if (p.verifiedAt) {
          totalVerificationMs += new Date(p.verifiedAt).getTime() - new Date(p.createdAt).getTime();
          verifiedWithTimeCount++;
        }
      } else if (p.status === 'REJECTED') {
        rejectedCount++;
      }
    }

    const totalProfiles = profiles.length;
    const approvalRate = totalProfiles > 0 ? Math.round(approvedCount / totalProfiles * 10000) / 100 : 0;
    const rejectionRate = totalProfiles > 0 ? Math.round(rejectedCount / totalProfiles * 10000) / 100 : 0;
    const avgVerificationDays = verifiedWithTimeCount > 0
      ? Math.round(totalVerificationMs / verifiedWithTimeCount / (1000 * 60 * 60 * 24) * 100) / 100
      : 0;

    return {
      totalProfiles,
      approvedCount,
      rejectedCount,
      pendingCount: totalProfiles - approvedCount - rejectedCount,
      approvalRate,
      rejectionRate,
      avgVerificationDays,
      byStatus,
      byDocumentType,
      byCountry,
    };
  }

  async getDocumentCompleteness(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const documents = [
      { name: 'documentFrontUrl', label: 'Document Front', uploaded: !!(profile as any).documentFrontUrl },
      { name: 'documentBackUrl', label: 'Document Back', uploaded: !!(profile as any).documentBackUrl },
      { name: 'selfieUrl', label: 'Selfie', uploaded: !!(profile as any).selfieUrl },
      { name: 'livenessImageUrl', label: 'Liveness Image', uploaded: !!(profile as any).livenessImageUrl },
    ];

    const uploadedCount = documents.filter(d => d.uploaded).length;
    const completeness = Math.round((uploadedCount / documents.length) * 100);
    const missingDocuments = documents.filter(d => !d.uploaded).map(d => d.label);

    const personalFields = [
      { name: 'firstName', filled: !!(profile as any).firstName },
      { name: 'lastName', filled: !!(profile as any).lastName },
      { name: 'dateOfBirth', filled: !!(profile as any).dateOfBirth },
      { name: 'nationality', filled: !!(profile as any).nationality },
      { name: 'documentNumber', filled: !!(profile as any).documentNumber },
      { name: 'documentCountry', filled: !!(profile as any).documentCountry },
    ];

    const filledPersonal = personalFields.filter(f => f.filled).length;
    const personalCompleteness = Math.round((filledPersonal / personalFields.length) * 100);

    const overallCompleteness = Math.round(((uploadedCount + filledPersonal) / (documents.length + personalFields.length)) * 100);
    const isReady = overallCompleteness === 100;

    return {
      documentCompleteness: completeness,
      personalCompleteness,
      overallCompleteness,
      isReady,
      uploadedDocuments: uploadedCount,
      totalDocuments: documents.length,
      missingDocuments,
      documents,
      personalFields,
      status: profile.status,
    };
  }

  async setRiskScore(userId: string, riskScore: number) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    return this.prisma.kycProfile.update({
      where: { userId },
      data: { riskScore },
    });
  }

  async getVerificationTimeline(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const transitions: Array<{ status: string; timestamp: Date }> = [];
    transitions.push({ status: 'CREATED', timestamp: profile.createdAt });

    if (profile.status === 'APPROVED' && profile.verifiedAt) {
      transitions.push({ status: 'VERIFIED', timestamp: profile.verifiedAt });
    } else if (profile.status === 'REJECTED') {
      transitions.push({ status: 'REJECTED', timestamp: profile.updatedAt });
    } else if (profile.status === 'IN_REVIEW') {
      transitions.push({ status: 'IN_REVIEW', timestamp: profile.updatedAt });
    }

    transitions.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const stages: Array<{ from: string; to: string; durationHours: number }> = [];
    for (let i = 0; i < transitions.length - 1; i++) {
      const durationMs = transitions[i + 1].timestamp.getTime() - transitions[i].timestamp.getTime();
      stages.push({
        from: transitions[i].status,
        to: transitions[i + 1].status,
        durationHours: Math.round((durationMs / 3600000) * 100) / 100,
      });
    }

    const totalHours = transitions.length >= 2
      ? Math.round(
          ((transitions[transitions.length - 1].timestamp.getTime() - transitions[0].timestamp.getTime()) / 3600000) * 100
        ) / 100
      : 0;

    const allProfiles = await this.prisma.kycProfile.findMany({
      where: { verifiedAt: { not: null } },
    });
    let systemAvgHours = 0;
    if (allProfiles.length > 0) {
      const totalSystemHours = allProfiles.reduce((sum, p) => {
        return sum + (p.verifiedAt!.getTime() - p.createdAt.getTime()) / 3600000;
      }, 0);
      systemAvgHours = Math.round((totalSystemHours / allProfiles.length) * 100) / 100;
    }

    return {
      userId,
      currentStatus: profile.status,
      transitions,
      stages,
      totalHours,
      systemAvgVerificationHours: systemAvgHours,
      fasterThanAverage: totalHours > 0 && totalHours < systemAvgHours,
    };
  }

  async getDocumentVerificationReport(userId: string) {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const documents = await this.prisma.kycDocument.findMany({ where: { userId } });

    if (documents.length === 0) {
      return {
        totalDocuments: 0,
        verified: 0,
        pending: 0,
        rejected: 0,
        verificationRate: 0,
        byDocumentType: [],
        avgProcessingDays: 0,
        oldestPendingDays: 0,
      };
    }

    const verified = documents.filter((d: any) => d.status === 'VERIFIED' || d.status === 'APPROVED');
    const pending = documents.filter((d: any) => d.status === 'PENDING' || d.status === 'IN_REVIEW');
    const rejected = documents.filter((d: any) => d.status === 'REJECTED');

    const verificationRate = documents.length > 0
      ? Math.round((verified.length / documents.length) * 10000) / 100
      : 0;

    const typeMap = new Map<string, { total: number; verified: number; pending: number; rejected: number }>();
    for (const doc of documents) {
      const docType = (doc as any).documentType ?? (doc as any).type ?? 'unknown';
      const entry = typeMap.get(docType) ?? { total: 0, verified: 0, pending: 0, rejected: 0 };
      entry.total++;
      const status = (doc as any).status;
      if (status === 'VERIFIED' || status === 'APPROVED') entry.verified++;
      else if (status === 'REJECTED') entry.rejected++;
      else entry.pending++;
      typeMap.set(docType, entry);
    }

    const byDocumentType = Array.from(typeMap.entries())
      .map(([type, data]) => ({
        type,
        total: data.total,
        verified: data.verified,
        pending: data.pending,
        rejected: data.rejected,
        verificationRate: data.total > 0 ? Math.round((data.verified / data.total) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.total - a.total);

    const processingDays = verified.map((d: any) => {
      const uploaded = new Date(d.createdAt).getTime();
      const verifiedAt = d.verifiedAt ?? d.updatedAt;
      return Math.max(0, Math.round((new Date(verifiedAt).getTime() - uploaded) / 86400000));
    });
    const avgProcessingDays = processingDays.length > 0
      ? Math.round(processingDays.reduce((s, d) => s + d, 0) / processingDays.length)
      : 0;

    let oldestPendingDays = 0;
    for (const d of pending) {
      const days = Math.round((Date.now() - new Date(d.createdAt).getTime()) / 86400000);
      if (days > oldestPendingDays) oldestPendingDays = days;
    }

    return {
      totalDocuments: documents.length,
      verified: verified.length,
      pending: pending.length,
      rejected: rejected.length,
      verificationRate,
      byDocumentType,
      avgProcessingDays,
      oldestPendingDays,
    };
  }

  async getKycRiskScoring(userId: string) {
    const kyc = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!kyc) throw new Error('kyc_not_found');

    let riskScore = 50;
    const factors: { factor: string; impact: number; detail: string }[] = [];

    if ((kyc as any).status === 'approved' || (kyc as any).status === 'verified') {
      riskScore -= 20;
      factors.push({ factor: 'verified_identity', impact: -20, detail: 'KYC verified' });
    } else if ((kyc as any).status === 'pending') {
      riskScore += 10;
      factors.push({ factor: 'pending_verification', impact: 10, detail: 'KYC pending review' });
    } else if ((kyc as any).status === 'rejected') {
      riskScore += 30;
      factors.push({ factor: 'rejected_kyc', impact: 30, detail: 'KYC was rejected' });
    }

    if ((kyc as any).documentType) {
      riskScore -= 5;
      factors.push({ factor: 'document_provided', impact: -5, detail: `Document: ${(kyc as any).documentType}` });
    }

    if ((kyc as any).selfieUrl || (kyc as any).selfie) {
      riskScore -= 5;
      factors.push({ factor: 'selfie_provided', impact: -5, detail: 'Selfie verification submitted' });
    }

    const ageDays = (Date.now() - new Date(kyc.createdAt).getTime()) / 86400000;
    if (ageDays > 365) {
      riskScore += 10;
      factors.push({ factor: 'stale_verification', impact: 10, detail: 'KYC over 1 year old' });
    }

    if ((kyc as any).riskLevel === 'high' || (kyc as any).riskFlag) {
      riskScore += 20;
      factors.push({ factor: 'flagged_risk', impact: 20, detail: 'Risk flag present' });
    }

    riskScore = Math.max(0, Math.min(100, riskScore));
    const riskLevel = riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low';

    return {
      userId,
      status: (kyc as any).status,
      riskScore,
      riskLevel,
      factors,
      lastUpdated: (kyc as any).updatedAt || kyc.createdAt,
    };
  }

  async getKycComplianceTimeline(userId: string) {
    const kyc = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!kyc) throw new Error('kyc_not_found');

    const events: Array<{ event: string; date: string; status: string }> = [];

    events.push({ event: 'profile_created', date: new Date(kyc.createdAt).toISOString(), status: 'completed' });

    if ((kyc as any).documentFrontUrl) {
      events.push({ event: 'document_uploaded', date: new Date((kyc as any).updatedAt || kyc.createdAt).toISOString(), status: 'completed' });
    } else {
      events.push({ event: 'document_upload', date: '', status: 'pending' });
    }

    if ((kyc as any).selfieUrl) {
      events.push({ event: 'selfie_uploaded', date: new Date((kyc as any).updatedAt || kyc.createdAt).toISOString(), status: 'completed' });
    } else {
      events.push({ event: 'selfie_upload', date: '', status: 'pending' });
    }

    const status = ((kyc as any).status || 'PENDING').toUpperCase();
    if (status === 'APPROVED' || status === 'VERIFIED') {
      events.push({ event: 'verification_approved', date: new Date((kyc as any).verifiedAt || (kyc as any).updatedAt || kyc.createdAt).toISOString(), status: 'completed' });
    } else if (status === 'REJECTED') {
      events.push({ event: 'verification_rejected', date: new Date((kyc as any).updatedAt || kyc.createdAt).toISOString(), status: 'failed' });
    } else {
      events.push({ event: 'verification', date: '', status: 'pending' });
    }

    const completedCount = events.filter(e => e.status === 'completed').length;
    const progress = Math.round((completedCount / events.length) * 100);

    return {
      userId,
      currentStatus: status,
      progress,
      totalSteps: events.length,
      completedSteps: completedCount,
      timeline: events,
    };
  }

  async getKycDocumentIntegrity(userId: string) {
    const kyc = await this.prisma.kycProfile.findUnique({ where: { userId } });
    if (!kyc) throw new Error('kyc_not_found');

    const checks: Array<{ field: string; status: string; severity: string }> = [];

    const hasDoc = !!(kyc as any).documentFrontUrl;
    checks.push({ field: 'document_front', status: hasDoc ? 'present' : 'missing', severity: hasDoc ? 'ok' : 'high' });

    const hasBack = !!(kyc as any).documentBackUrl;
    checks.push({ field: 'document_back', status: hasBack ? 'present' : 'missing', severity: hasBack ? 'ok' : 'medium' });

    const hasSelfie = !!(kyc as any).selfieUrl;
    checks.push({ field: 'selfie', status: hasSelfie ? 'present' : 'missing', severity: hasSelfie ? 'ok' : 'high' });

    const hasDocType = !!(kyc as any).documentType;
    checks.push({ field: 'document_type', status: hasDocType ? 'present' : 'missing', severity: hasDocType ? 'ok' : 'medium' });

    const hasDocNumber = !!(kyc as any).documentNumber;
    checks.push({ field: 'document_number', status: hasDocNumber ? 'present' : 'missing', severity: hasDocNumber ? 'ok' : 'high' });

    const passedChecks = checks.filter(c => c.severity === 'ok').length;
    const integrityScore = Math.round((passedChecks / checks.length) * 100);

    const highIssues = checks.filter(c => c.severity === 'high').length;
    const mediumIssues = checks.filter(c => c.severity === 'medium').length;
    const integrityLevel = highIssues > 0 ? 'incomplete' : mediumIssues > 0 ? 'partial' : 'complete';

    const recommendations: string[] = [];
    if (!hasDoc) recommendations.push('Upload front of identity document');
    if (!hasSelfie) recommendations.push('Upload selfie for identity verification');
    if (!hasDocNumber) recommendations.push('Provide document number');

    return {
      userId,
      integrityScore,
      integrityLevel,
      totalChecks: checks.length,
      passedChecks,
      checks,
      recommendations,
    };
  }

  async getKycRenewalForecast(userId: string) {
    const profile = await this.prisma.kycProfile.findFirst({ where: { userId } });
    if (!profile) throw new Error('kyc_not_found');

    const now = new Date();
    const createdAt = new Date(profile.createdAt);
    const updatedAt = new Date(profile.updatedAt);
    const accountAgeDays = Math.floor((now.getTime() - createdAt.getTime()) / 86400000);
    const daysSinceUpdate = Math.floor((now.getTime() - updatedAt.getTime()) / 86400000);

    const checks: { check: string; status: string; urgency: string }[] = [];

    const verificationStatus = profile.status || 'PENDING';
    checks.push({
      check: 'identity_verification',
      status: verificationStatus === 'VERIFIED' || verificationStatus === 'APPROVED' ? 'current' : 'needs_renewal',
      urgency: verificationStatus === 'VERIFIED' || verificationStatus === 'APPROVED' ? 'none' : 'high',
    });

    const documentExpiry = daysSinceUpdate > 365;
    checks.push({
      check: 'document_validity',
      status: documentExpiry ? 'expired' : 'current',
      urgency: documentExpiry ? 'high' : daysSinceUpdate > 270 ? 'medium' : 'none',
    });

    checks.push({
      check: 'periodic_review',
      status: daysSinceUpdate > 180 ? 'overdue' : 'current',
      urgency: daysSinceUpdate > 180 ? 'high' : daysSinceUpdate > 120 ? 'medium' : 'none',
    });

    checks.push({
      check: 'risk_reassessment',
      status: accountAgeDays > 365 && daysSinceUpdate > 90 ? 'due' : 'current',
      urgency: accountAgeDays > 365 && daysSinceUpdate > 90 ? 'medium' : 'none',
    });

    const urgentCount = checks.filter(c => c.urgency === 'high').length;
    const dueCount = checks.filter(c => c.urgency === 'medium').length;

    let renewalScore = 100;
    renewalScore -= urgentCount * 25;
    renewalScore -= dueCount * 10;
    renewalScore = Math.max(0, renewalScore);

    const renewalStatus = renewalScore >= 70 ? 'current' : renewalScore >= 40 ? 'renewal_due' : 'urgent_renewal';

    const recommendations: string[] = [];
    if (urgentCount > 0) recommendations.push(`${urgentCount} check(s) require immediate attention`);
    if (dueCount > 0) recommendations.push(`${dueCount} check(s) due for renewal soon`);
    if (daysSinceUpdate > 365) recommendations.push('KYC profile not updated in over a year');

    return {
      renewalStatus,
      renewalScore,
      accountAgeDays,
      daysSinceLastUpdate: daysSinceUpdate,
      totalChecks: checks.length,
      urgentChecks: urgentCount,
      checks,
      recommendations,
    };
  }
}
