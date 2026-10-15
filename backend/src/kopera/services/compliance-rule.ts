import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class ComplianceRuleService {
  constructor(private prisma: PrismaClient) {}

  async createRule(userId: string, data: {
    name: string;
    ruleType: string;
    condition: string;
    action: string;
    severity: string;
    description?: string;
  }) {
    const existing = await this.prisma.complianceRule.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('rule_name_exists');

    return this.prisma.complianceRule.create({
      data: {
        userId,
        name: data.name,
        ruleType: data.ruleType.toUpperCase(),
        condition: data.condition,
        action: data.action,
        severity: data.severity.toUpperCase(),
        description: data.description || null,
        isActive: true,
        triggerCount: 0,
        reference: `CRL-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getRules(userId: string) {
    return this.prisma.complianceRule.findMany({ where: { userId } });
  }

  async getRule(userId: string, id: string) {
    const rule = await this.prisma.complianceRule.findUnique({ where: { id } });
    if (!rule) throw new Error('rule_not_found');
    if ((rule as any).userId !== userId) throw new Error('rule_not_found');
    return rule;
  }

  async updateRule(userId: string, id: string, data: {
    condition?: string;
    action?: string;
    severity?: string;
    description?: string;
  }) {
    await this.getRule(userId, id);
    const updateData: Record<string, unknown> = {};
    if (data.condition !== undefined) updateData.condition = data.condition;
    if (data.action !== undefined) updateData.action = data.action;
    if (data.severity !== undefined) updateData.severity = data.severity.toUpperCase();
    if (data.description !== undefined) updateData.description = data.description;

    return this.prisma.complianceRule.update({ where: { id }, data: updateData });
  }

  async toggleRule(userId: string, id: string, active: boolean) {
    await this.getRule(userId, id);
    return this.prisma.complianceRule.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async recordTrigger(userId: string, id: string) {
    const rule = await this.getRule(userId, id);
    return this.prisma.complianceRule.update({
      where: { id },
      data: { triggerCount: ((rule as any).triggerCount || 0) + 1, lastTriggeredAt: new Date() },
    });
  }

  async deleteRule(userId: string, id: string) {
    await this.getRule(userId, id);
    return this.prisma.complianceRule.delete({ where: { id } });
  }

  async getRuleAnalytics(userId: string) {
    const rules = await this.prisma.complianceRule.findMany({ where: { userId } });

    if (rules.length === 0) {
      return {
        totalRules: 0,
        activeRules: 0,
        severities: {},
        totalTriggers: 0,
        analyticsLevel: 'no_data',
      };
    }

    const active = (rules as any[]).filter((r) => r.isActive).length;
    const severities: Record<string, number> = {};
    let totalTriggers = 0;
    for (const r of rules as any[]) {
      severities[r.severity] = (severities[r.severity] || 0) + 1;
      totalTriggers += r.triggerCount || 0;
    }

    return {
      totalRules: rules.length,
      activeRules: active,
      severities,
      totalTriggers,
      analyticsLevel: rules.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
