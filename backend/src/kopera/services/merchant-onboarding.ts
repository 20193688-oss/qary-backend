import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class MerchantOnboardingService {
  constructor(private prisma: PrismaClient) {}

  async createApplication(userId: string, data: {
    businessName: string;
    businessType: string;
    contactEmail: string;
    country: string;
  }) {
    return this.prisma.merchantOnboarding.create({
      data: {
        userId,
        businessName: data.businessName,
        businessType: data.businessType.toUpperCase(),
        contactEmail: data.contactEmail,
        country: data.country.toUpperCase(),
        completedSteps: 0,
        totalSteps: 5,
        status: 'IN_PROGRESS',
        reference: `MOB-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getApplications(userId: string) {
    return this.prisma.merchantOnboarding.findMany({ where: { userId } });
  }

  async getApplication(userId: string, id: string) {
    const a = await this.prisma.merchantOnboarding.findUnique({ where: { id } });
    if (!a) throw new Error('application_not_found');
    if ((a as any).userId !== userId) throw new Error('application_not_found');
    return a;
  }

  async advanceStep(userId: string, id: string) {
    const a = await this.getApplication(userId, id);
    if ((a as any).status !== 'IN_PROGRESS') throw new Error('application_not_in_progress');
    const newCompleted = ((a as any).completedSteps || 0) + 1;
    const total = (a as any).totalSteps || 5;
    const isComplete = newCompleted >= total;

    return this.prisma.merchantOnboarding.update({
      where: { id },
      data: {
        completedSteps: newCompleted,
        status: isComplete ? 'COMPLETED' : 'IN_PROGRESS',
        completedAt: isComplete ? new Date() : null,
      },
    });
  }

  async approveApplication(userId: string, id: string) {
    const a = await this.getApplication(userId, id);
    if ((a as any).status !== 'COMPLETED') throw new Error('application_not_completed');

    return this.prisma.merchantOnboarding.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
  }

  async rejectApplication(userId: string, id: string, reason: string) {
    const a = await this.getApplication(userId, id);
    if ((a as any).status === 'REJECTED' || (a as any).status === 'APPROVED') throw new Error('application_already_resolved');

    return this.prisma.merchantOnboarding.update({
      where: { id },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectionReason: reason },
    });
  }

  async getOnboardingAnalytics(userId: string) {
    const apps = await this.prisma.merchantOnboarding.findMany({ where: { userId } });

    if (apps.length === 0) {
      return {
        totalApplications: 0,
        breakdown: { IN_PROGRESS: 0, COMPLETED: 0, APPROVED: 0, REJECTED: 0 },
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { IN_PROGRESS: 0, COMPLETED: 0, APPROVED: 0, REJECTED: 0 };
    for (const a of apps as any[]) {
      if (a.status in breakdown) breakdown[a.status]++;
    }

    return {
      totalApplications: apps.length,
      breakdown,
      analyticsLevel: apps.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
