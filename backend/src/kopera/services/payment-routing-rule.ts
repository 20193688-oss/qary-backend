import type { PrismaClient } from '@prisma/client';

export class PaymentRoutingRuleService {
  constructor(private prisma: PrismaClient) {}

  async createRule(userId: string, data: {
    name: string;
    condition: string;
    targetGateway: string;
    priority: number;
    currency: string;
    minAmount: bigint;
    maxAmount: bigint;
  }) {
    return this.prisma.paymentRoutingRule.create({
      data: {
        userId,
        name: data.name,
        condition: data.condition.toUpperCase(),
        targetGateway: data.targetGateway,
        priority: data.priority,
        currency: data.currency.toUpperCase(),
        minAmount: data.minAmount,
        maxAmount: data.maxAmount,
        isActive: true,
        matchCount: 0,
        lastMatchedAt: null,
      },
    });
  }

  async getRules(userId: string) {
    return this.prisma.paymentRoutingRule.findMany({ where: { userId } });
  }

  async getRule(userId: string, id: string) {
    const r = await this.prisma.paymentRoutingRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('routing_rule_not_found');
    return r;
  }

  async recordMatch(userId: string, id: string) {
    const r = await this.prisma.paymentRoutingRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('routing_rule_not_found');
    if (!r.isActive) throw new Error('rule_not_active');
    return this.prisma.paymentRoutingRule.update({
      where: { id },
      data: {
        matchCount: r.matchCount + 1,
        lastMatchedAt: new Date(),
      },
    });
  }

  async toggleRule(userId: string, id: string, active: boolean) {
    const r = await this.prisma.paymentRoutingRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('routing_rule_not_found');
    return this.prisma.paymentRoutingRule.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async deleteRule(userId: string, id: string) {
    const r = await this.prisma.paymentRoutingRule.findFirst({ where: { id, userId } });
    if (!r) throw new Error('routing_rule_not_found');
    return this.prisma.paymentRoutingRule.delete({ where: { id } });
  }

  async getRoutingAnalytics(userId: string) {
    const all = await this.prisma.paymentRoutingRule.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalRules: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((r) => r.isActive).length;
    let totalMatches = 0;
    for (const r of all) totalMatches += r.matchCount;
    const byGateway: Record<string, number> = {};
    for (const r of all) byGateway[r.targetGateway] = (byGateway[r.targetGateway] || 0) + 1;
    return {
      totalRules: all.length,
      activeCount,
      totalMatches,
      byGateway,
      analyticsLevel: 'full' as const,
    };
  }
}
