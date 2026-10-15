import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

export class SecretKeyService {
  constructor(private prisma: PrismaClient) {}

  async createKey(userId: string, data: {
    secretKey: string;
    label?: string;
  }) {
    if (data.secretKey.length < 6) throw new Error('key_too_short');
    if (data.secretKey.length > 32) throw new Error('key_too_long');

    const existing = await this.prisma.userSecretKey.findMany({
      where: { userId, isActive: true },
    });
    if (existing.length >= 3) throw new Error('max_keys_reached');

    const keyHash = this.hashKey(data.secretKey);

    return this.prisma.userSecretKey.create({
      data: {
        userId,
        keyHash,
        label: data.label || `Key ${existing.length + 1}`,
        isActive: true,
        reference: `KEY-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getKeys(userId: string) {
    const keys = await this.prisma.userSecretKey.findMany({ where: { userId } });
    return keys.map((k: any) => ({
      id: k.id,
      label: k.label,
      isActive: k.isActive,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    }));
  }

  async validateKey(userId: string, secretKey: string) {
    const keyHash = this.hashKey(secretKey);
    const key = await this.prisma.userSecretKey.findFirst({
      where: { userId, keyHash, isActive: true },
    });

    if (!key) return { valid: false };

    await this.prisma.userSecretKey.update({
      where: { id: (key as any).id },
      data: { lastUsedAt: new Date() },
    });

    return { valid: true, keyId: (key as any).id };
  }

  async revokeKey(userId: string, keyId: string) {
    const key = await this.prisma.userSecretKey.findUnique({ where: { id: keyId } });
    if (!key) throw new Error('key_not_found');
    if ((key as any).userId !== userId) throw new Error('key_not_found');
    if (!(key as any).isActive) throw new Error('key_already_revoked');

    return this.prisma.userSecretKey.update({
      where: { id: keyId },
      data: { isActive: false, revokedAt: new Date() },
    });
  }

  async rotateKey(userId: string, keyId: string, newSecretKey: string) {
    if (newSecretKey.length < 6) throw new Error('key_too_short');
    if (newSecretKey.length > 32) throw new Error('key_too_long');

    const key = await this.prisma.userSecretKey.findUnique({ where: { id: keyId } });
    if (!key) throw new Error('key_not_found');
    if ((key as any).userId !== userId) throw new Error('key_not_found');
    if (!(key as any).isActive) throw new Error('key_already_revoked');

    const newHash = this.hashKey(newSecretKey);

    return this.prisma.userSecretKey.update({
      where: { id: keyId },
      data: { keyHash: newHash, rotatedAt: new Date() },
    });
  }

  async getKeySecurityReport(userId: string) {
    const keys = await this.prisma.userSecretKey.findMany({ where: { userId } });
    const active = keys.filter((k: any) => k.isActive);
    const revoked = keys.filter((k: any) => !k.isActive);

    if (keys.length === 0) {
      return {
        totalKeys: 0,
        activeKeys: 0,
        revokedKeys: 0,
        hasActiveKey: false,
        securityLevel: 'no_key',
        recommendations: ['Create a secret key for enhanced transaction security'],
      };
    }

    const recommendations: string[] = [];
    if (active.length === 0) {
      recommendations.push('No active keys - create a new key for transaction security');
    }

    const oldKeys = active.filter((k: any) => {
      const age = Date.now() - new Date(k.createdAt).getTime();
      return age > 90 * 24 * 60 * 60 * 1000;
    });
    if (oldKeys.length > 0) {
      recommendations.push('Some keys are older than 90 days - consider rotating them');
    }

    let securityLevel: string;
    if (active.length > 0 && recommendations.length === 0) securityLevel = 'strong';
    else if (active.length > 0) securityLevel = 'moderate';
    else securityLevel = 'weak';

    return {
      totalKeys: keys.length,
      activeKeys: active.length,
      revokedKeys: revoked.length,
      hasActiveKey: active.length > 0,
      securityLevel,
      recommendations,
    };
  }

  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
