import type { PrismaClient } from '@prisma/client';

export class TransactionAlertRuleService {
  constructor(private prisma: PrismaClient) {}

  async createRule(userId: string, data: {
    name: string;
    condition: string;
    threshold: bigint;
    currency: string;
    channel: string;
  }) {
    const existing = await this.prisma.transactionAlertRule.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('rule_name_duplicate');
    return this.prisma.transactionAlertRule.create({
      data: {
        userId,
        name: data.name,
        condition: data.condition.toUpperCase(),
        threshold: data.threshold,
        currency: data.currency.toUpperCase(),
        channel: data.channel.toUpperCase(),
        isActive: true,
        triggerCount: 0,
        lastTriggeredAt: null,
      },
    });
  }

  async getRules(userId: string) {
    return this.prisma.transactionAlertRule.findMany({ where: { userId } });
  }

  async getRule(userId: string, id: string) {
    const r = await this.prisma.transactionAlertRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rule_not_found');
    return r;
  }

  async triggerRule(userId: string, id: string) {
    const r = await this.prisma.transactionAlertRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rule_not_found');
    if (!r.isActive) throw new Error('rule_not_active');
    return this.prisma.transactionAlertRule.update({
      where: { id },
      data: {
        triggerCount: r.triggerCount + 1,
        lastTriggeredAt: new Date(),
      },
    });
  }

  async toggleRule(userId: string, id: string, active: boolean) {
    const r = await this.prisma.transactionAlertRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rule_not_found');
    return this.prisma.transactionAlertRule.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteRule(userId: string, id: string) {
    const r = await this.prisma.transactionAlertRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('rule_not_found');
    return this.prisma.transactionAlertRule.delete({ where: { id } });
  }

  async getRuleAnalytics(userId: string) {
    const all = await this.prisma.transactionAlertRule.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalRules: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((r) => r.isActive).length;
    let totalTriggers = 0;
    for (const r of all) totalTriggers += r.triggerCount;
    const byCondition: Record<string, number> = {};
    for (const r of all) byCondition[r.condition] = (byCondition[r.condition] || 0) + 1;
    const byChannel: Record<string, number> = {};
    for (const r of all) byChannel[r.channel] = (byChannel[r.channel] || 0) + 1;
    return {
      totalRules: all.length,
      activeCount,
      totalTriggers,
      byCondition,
      byChannel,
      analyticsLevel: 'full' as const,
    };
  }
}
