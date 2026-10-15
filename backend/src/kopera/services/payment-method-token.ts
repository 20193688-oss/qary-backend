import type { PrismaClient } from '@prisma/client';
import { randomBytes, createHash } from 'node:crypto';

export class PaymentMethodTokenService {
  constructor(private prisma: PrismaClient) {}

  async createToken(userId: string, data: {
    methodType: string;
    lastFour: string;
    expiryMonth: number;
    expiryYear: number;
    billingCountry: string;
  }) {
    const tokenValue = `tok_${randomBytes(24).toString('hex')}`;
    const tokenHash = createHash('sha256').update(tokenValue).digest('hex');
    return {
      record: await this.prisma.paymentMethodToken.create({
        data: {
          userId,
          methodType: data.methodType.toUpperCase(),
          lastFour: data.lastFour,
          expiryMonth: data.expiryMonth,
          expiryYear: data.expiryYear,
          billingCountry: data.billingCountry.toUpperCase(),
          tokenHash,
          tokenPrefix: tokenValue.slice(0, 12),
          isActive: true,
          usageCount: 0,
          lastUsedAt: null,
        },
      }),
      token: tokenValue,
    };
  }

  async getTokens(userId: string) {
    return this.prisma.paymentMethodToken.findMany({ where: { userId } });
  }

  async getToken(userId: string, id: string) {
    const t = await this.prisma.paymentMethodToken.findFirst({ where: { id, userId } });
    if (!t) throw new Error('token_not_found');
    return t;
  }

  async useToken(userId: string, id: string) {
    const t = await this.prisma.paymentMethodToken.findFirst({ where: { id, userId } });
    if (!t) throw new Error('token_not_found');
    if (!t.isActive) throw new Error('token_not_active');
    return this.prisma.paymentMethodToken.update({
      where: { id },
      data: {
        usageCount: t.usageCount + 1,
        lastUsedAt: new Date(),
      },
    });
  }

  async deactivateToken(userId: string, id: string) {
    const t = await this.prisma.paymentMethodToken.findFirst({ where: { id, userId } });
    if (!t) throw new Error('token_not_found');
    if (!t.isActive) throw new Error('token_already_inactive');
    return this.prisma.paymentMethodToken.update({
      where: { id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  }

  async deleteToken(userId: string, id: string) {
    const t = await this.prisma.paymentMethodToken.findFirst({ where: { id, userId } });
    if (!t) throw new Error('token_not_found');
    return this.prisma.paymentMethodToken.delete({ where: { id } });
  }

  async getTokenAnalytics(userId: string) {
    const all = await this.prisma.paymentMethodToken.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalTokens: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((t) => t.isActive).length;
    let totalUsage = 0;
    for (const t of all) totalUsage += t.usageCount;
    const byMethodType: Record<string, number> = {};
    for (const t of all) byMethodType[t.methodType] = (byMethodType[t.methodType] || 0) + 1;
    return {
      totalTokens: all.length,
      activeCount,
      totalUsage,
      byMethodType,
      analyticsLevel: 'full' as const,
    };
  }
}
