import type { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class ApiKeyService {
  constructor(private prisma: PrismaClient) {}

  async createKey(userId: string, data: {
    name: string;
    permissions: string[];
    expiresInDays?: number;
  }) {
    const existing = await this.prisma.apiKey.findMany({ where: { userId } });
    const activeCount = (existing as any[]).filter((k) => k.isActive).length;
    if (activeCount >= 5) throw new Error('max_api_keys_reached');

    const rawKey = `kp_${randomBytes(32).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const prefix = rawKey.slice(0, 10);
    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId,
        name: data.name,
        keyHash,
        keyPrefix: prefix,
        permissions: JSON.stringify(data.permissions),
        isActive: true,
        expiresAt,
        reference: `AK-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });

    return { ...(apiKey as any), rawKey, keyHash: undefined };
  }

  async getKeys(userId: string) {
    const keys = await this.prisma.apiKey.findMany({ where: { userId } });
    return (keys as any[]).map((k) => ({
      ...k,
      keyHash: undefined,
      permissions: typeof k.permissions === 'string' ? JSON.parse(k.permissions) : k.permissions,
    }));
  }

  async validateKey(rawKey: string) {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keys = await this.prisma.apiKey.findMany({});
    const key = (keys as any[]).find((k) => k.keyHash === keyHash && k.isActive);
    if (!key) return { valid: false, userId: null };

    if (key.expiresAt && new Date() > new Date(key.expiresAt)) {
      await this.prisma.apiKey.update({
        where: { id: key.id },
        data: { isActive: false },
      });
      return { valid: false, userId: null, reason: 'expired' };
    }

    await this.prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      valid: true,
      userId: key.userId,
      permissions: typeof key.permissions === 'string' ? JSON.parse(key.permissions) : key.permissions,
    };
  }

  async revokeKey(userId: string, id: string) {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw new Error('api_key_not_found');
    if ((key as any).userId !== userId) throw new Error('api_key_not_found');

    return this.prisma.apiKey.update({
      where: { id },
      data: { isActive: false, revokedAt: new Date() },
    });
  }

  async getApiKeyAnalytics(userId: string) {
    const keys = await this.prisma.apiKey.findMany({ where: { userId } });

    if (keys.length === 0) {
      return {
        totalKeys: 0,
        activeKeys: 0,
        revokedKeys: 0,
        expiringKeys: 0,
        analyticsLevel: 'no_data',
      };
    }

    const active = (keys as any[]).filter((k) => k.isActive).length;
    const revoked = (keys as any[]).filter((k) => !k.isActive).length;
    const now = new Date();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiring = (keys as any[]).filter(
      (k) => k.isActive && k.expiresAt && new Date(k.expiresAt).getTime() - now.getTime() < thirtyDays,
    ).length;

    let analyticsLevel: string;
    if (active === 0) analyticsLevel = 'no_active_keys';
    else if (expiring > 0) analyticsLevel = 'action_needed';
    else analyticsLevel = 'healthy';

    return {
      totalKeys: keys.length,
      activeKeys: active,
      revokedKeys: revoked,
      expiringKeys: expiring,
      analyticsLevel,
    };
  }
}
