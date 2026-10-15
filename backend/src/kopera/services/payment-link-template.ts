import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentLinkTemplateService {
  constructor(private prisma: PrismaClient) {}

  async createTemplate(userId: string, data: {
    name: string;
    amount: bigint;
    currency: string;
    description?: string;
    redirectUrl?: string;
  }) {
    const existing = await this.prisma.paymentLinkTemplate.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('template_exists');

    return this.prisma.paymentLinkTemplate.create({
      data: {
        userId,
        name: data.name,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        description: data.description || null,
        redirectUrl: data.redirectUrl || null,
        usageCount: 0,
        isActive: true,
        reference: `PLT-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getTemplates(userId: string) {
    return this.prisma.paymentLinkTemplate.findMany({ where: { userId } });
  }

  async getTemplate(userId: string, id: string) {
    const t = await this.prisma.paymentLinkTemplate.findUnique({ where: { id } });
    if (!t) throw new Error('template_not_found');
    if ((t as any).userId !== userId) throw new Error('template_not_found');
    return t;
  }

  async useTemplate(userId: string, id: string) {
    const t = await this.getTemplate(userId, id);
    if (!(t as any).isActive) throw new Error('template_not_active');

    return this.prisma.paymentLinkTemplate.update({
      where: { id },
      data: { usageCount: ((t as any).usageCount || 0) + 1, lastUsedAt: new Date() },
    });
  }

  async toggleTemplate(userId: string, id: string, active: boolean) {
    await this.getTemplate(userId, id);
    return this.prisma.paymentLinkTemplate.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteTemplate(userId: string, id: string) {
    await this.getTemplate(userId, id);
    return this.prisma.paymentLinkTemplate.delete({ where: { id } });
  }

  async getTemplateAnalytics(userId: string) {
    const templates = await this.prisma.paymentLinkTemplate.findMany({ where: { userId } });

    if (templates.length === 0) {
      return {
        totalTemplates: 0,
        activeTemplates: 0,
        totalUsage: 0,
        analyticsLevel: 'no_data',
      };
    }

    let activeCount = 0;
    let totalUsage = 0;
    for (const t of templates as any[]) {
      if (t.isActive) activeCount++;
      totalUsage += t.usageCount || 0;
    }

    return {
      totalTemplates: templates.length,
      activeTemplates: activeCount,
      totalUsage,
      analyticsLevel: templates.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
