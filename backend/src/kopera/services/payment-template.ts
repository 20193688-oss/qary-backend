import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PaymentTemplateService {
  constructor(private prisma: PrismaClient) {}

  async createTemplate(userId: string, data: {
    name: string;
    recipientName: string;
    recipientAccount: string;
    amount?: bigint;
    currency: string;
    description?: string;
    category?: string;
  }) {
    return this.prisma.paymentTemplate.create({
      data: {
        userId,
        name: data.name,
        recipientName: data.recipientName,
        recipientAccount: data.recipientAccount,
        amount: data.amount || null,
        currency: data.currency.toUpperCase(),
        description: data.description || null,
        category: data.category || 'GENERAL',
        usageCount: 0,
        isActive: true,
        reference: `TPL-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getTemplates(userId: string) {
    return this.prisma.paymentTemplate.findMany({ where: { userId } });
  }

  async getTemplate(userId: string, id: string) {
    const tpl = await this.prisma.paymentTemplate.findUnique({ where: { id } });
    if (!tpl) throw new Error('template_not_found');
    if ((tpl as any).userId !== userId) throw new Error('template_not_found');
    return tpl;
  }

  async updateTemplate(userId: string, id: string, data: {
    name?: string;
    recipientName?: string;
    recipientAccount?: string;
    amount?: bigint;
    currency?: string;
    description?: string;
    category?: string;
  }) {
    await this.getTemplate(userId, id);
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.recipientName !== undefined) updateData.recipientName = data.recipientName;
    if (data.recipientAccount !== undefined) updateData.recipientAccount = data.recipientAccount;
    if (data.amount !== undefined) updateData.amount = data.amount;
    if (data.currency !== undefined) updateData.currency = data.currency.toUpperCase();
    if (data.description !== undefined) updateData.description = data.description;
    if (data.category !== undefined) updateData.category = data.category;

    return this.prisma.paymentTemplate.update({ where: { id }, data: updateData });
  }

  async useTemplate(userId: string, id: string) {
    const tpl = await this.getTemplate(userId, id);
    if (!(tpl as any).isActive) throw new Error('template_inactive');

    return this.prisma.paymentTemplate.update({
      where: { id },
      data: { usageCount: ((tpl as any).usageCount || 0) + 1, lastUsedAt: new Date() },
    });
  }

  async toggleTemplate(userId: string, id: string, active: boolean) {
    await this.getTemplate(userId, id);
    return this.prisma.paymentTemplate.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteTemplate(userId: string, id: string) {
    await this.getTemplate(userId, id);
    return this.prisma.paymentTemplate.delete({ where: { id } });
  }

  async getTemplateAnalytics(userId: string) {
    const templates = await this.prisma.paymentTemplate.findMany({ where: { userId } });

    if (templates.length === 0) {
      return {
        totalTemplates: 0,
        activeTemplates: 0,
        categories: {},
        totalUsage: 0,
        analyticsLevel: 'no_data',
      };
    }

    const active = (templates as any[]).filter((t) => t.isActive).length;
    const categories: Record<string, number> = {};
    let totalUsage = 0;
    for (const t of templates as any[]) {
      categories[t.category] = (categories[t.category] || 0) + 1;
      totalUsage += t.usageCount || 0;
    }

    return {
      totalTemplates: templates.length,
      activeTemplates: active,
      categories,
      totalUsage,
      analyticsLevel: templates.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
