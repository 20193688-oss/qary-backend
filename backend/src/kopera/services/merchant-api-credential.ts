import type { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

export class MerchantApiCredentialService {
  constructor(private prisma: PrismaClient) {}

  async createCredential(userId: string, data: {
    merchantId: string;
    label: string;
    environment: string;
    permissions: string;
  }) {
    const apiKey = `mk_${randomBytes(24).toString('hex')}`;
    const apiSecret = `ms_${randomBytes(32).toString('hex')}`;
    const hashedSecret = createHash('sha256').update(apiSecret).digest('hex');
    return {
      record: await this.prisma.merchantApiCredential.create({
        data: {
          userId,
          merchantId: data.merchantId,
          label: data.label,
          environment: data.environment.toUpperCase(),
          permissions: data.permissions.toUpperCase(),
          apiKeyPrefix: apiKey.slice(0, 12),
          apiKeyHash: createHash('sha256').update(apiKey).digest('hex'),
          secretHash: hashedSecret,
          isActive: true,
          usageCount: 0,
          lastUsedAt: null,
        },
      }),
      apiKey,
      apiSecret,
    };
  }

  async getCredentials(userId: string) {
    return this.prisma.merchantApiCredential.findMany({ where: { userId } });
  }

  async getCredential(userId: string, id: string) {
    const c = await this.prisma.merchantApiCredential.findFirst({ where: { id, userId } });
    if (!c) throw new Error('credential_not_found');
    return c;
  }

  async recordUsage(userId: string, id: string) {
    const c = await this.prisma.merchantApiCredential.findFirst({ where: { id, userId } });
    if (!c) throw new Error('credential_not_found');
    if (!c.isActive) throw new Error('credential_not_active');
    return this.prisma.merchantApiCredential.update({
      where: { id },
      data: {
        usageCount: c.usageCount + 1,
        lastUsedAt: new Date(),
      },
    });
  }

  async revokeCredential(userId: string, id: string) {
    const c = await this.prisma.merchantApiCredential.findFirst({ where: { id, userId } });
    if (!c) throw new Error('credential_not_found');
    if (!c.isActive) throw new Error('credential_already_revoked');
    return this.prisma.merchantApiCredential.update({
      where: { id },
      data: { isActive: false, revokedAt: new Date() },
    });
  }

  async deleteCredential(userId: string, id: string) {
    const c = await this.prisma.merchantApiCredential.findFirst({ where: { id, userId } });
    if (!c) throw new Error('credential_not_found');
    return this.prisma.merchantApiCredential.delete({ where: { id } });
  }

  async getCredentialAnalytics(userId: string) {
    const all = await this.prisma.merchantApiCredential.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalCredentials: 0, analyticsLevel: 'no_data' as const };
    }
    const activeCount = all.filter((c) => c.isActive).length;
    let totalUsage = 0;
    for (const c of all) totalUsage += c.usageCount;
    const byEnvironment: Record<string, number> = {};
    for (const c of all) byEnvironment[c.environment] = (byEnvironment[c.environment] || 0) + 1;
    return {
      totalCredentials: all.length,
      activeCount,
      revokedCount: all.length - activeCount,
      totalUsage,
      byEnvironment,
      analyticsLevel: 'full' as const,
    };
  }
}
