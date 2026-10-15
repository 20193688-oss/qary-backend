import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class PayoutMethodService {
  constructor(private prisma: PrismaClient) {}

  async addMethod(userId: string, data: {
    methodType: string;
    provider: string;
    accountIdentifier: string;
    currency: string;
    label?: string;
  }) {
    const existing = await this.prisma.payoutMethod.findFirst({
      where: { userId, provider: data.provider.toUpperCase(), accountIdentifier: data.accountIdentifier },
    });
    if (existing) throw new Error('payout_method_exists');

    return this.prisma.payoutMethod.create({
      data: {
        userId,
        methodType: data.methodType.toUpperCase(),
        provider: data.provider.toUpperCase(),
        accountIdentifier: data.accountIdentifier,
        currency: data.currency.toUpperCase(),
        label: data.label || null,
        isDefault: false,
        isVerified: false,
        status: 'ACTIVE',
        reference: `POM-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getMethods(userId: string) {
    return this.prisma.payoutMethod.findMany({ where: { userId } });
  }

  async getMethod(userId: string, id: string) {
    const m = await this.prisma.payoutMethod.findUnique({ where: { id } });
    if (!m) throw new Error('payout_method_not_found');
    if ((m as any).userId !== userId) throw new Error('payout_method_not_found');
    return m;
  }

  async verifyMethod(userId: string, id: string) {
    const m = await this.getMethod(userId, id);
    if ((m as any).isVerified) throw new Error('payout_method_already_verified');

    return this.prisma.payoutMethod.update({
      where: { id },
      data: { isVerified: true, verifiedAt: new Date() },
    });
  }

  async setDefault(userId: string, id: string) {
    await this.getMethod(userId, id);
    await this.prisma.payoutMethod.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
    return this.prisma.payoutMethod.update({
      where: { id },
      data: { isDefault: true },
    });
  }

  async disableMethod(userId: string, id: string) {
    const m = await this.getMethod(userId, id);
    if ((m as any).status !== 'ACTIVE') throw new Error('payout_method_not_active');

    return this.prisma.payoutMethod.update({
      where: { id },
      data: { status: 'DISABLED', disabledAt: new Date() },
    });
  }

  async deleteMethod(userId: string, id: string) {
    await this.getMethod(userId, id);
    return this.prisma.payoutMethod.delete({ where: { id } });
  }

  async getPayoutAnalytics(userId: string) {
    const methods = await this.prisma.payoutMethod.findMany({ where: { userId } });

    if (methods.length === 0) {
      return {
        totalMethods: 0,
        verifiedCount: 0,
        providers: {},
        analyticsLevel: 'no_data',
      };
    }

    let verifiedCount = 0;
    const providers: Record<string, number> = {};
    for (const m of methods as any[]) {
      if (m.isVerified) verifiedCount++;
      providers[m.provider] = (providers[m.provider] || 0) + 1;
    }

    return {
      totalMethods: methods.length,
      verifiedCount,
      providers,
      analyticsLevel: methods.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
