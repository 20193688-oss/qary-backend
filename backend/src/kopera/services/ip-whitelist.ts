import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class IpWhitelistService {
  constructor(private prisma: PrismaClient) {}

  async addIp(userId: string, data: {
    ipAddress: string;
    label?: string;
    expiresAt?: Date;
  }) {
    const existing = await this.prisma.ipWhitelist.findMany({ where: { userId } });
    const activeCount = (existing as any[]).filter((e) => e.isActive).length;
    if (activeCount >= 20) throw new Error('max_ips_reached');

    const duplicate = (existing as any[]).find(
      (e) => e.ipAddress === data.ipAddress && e.isActive,
    );
    if (duplicate) throw new Error('ip_already_whitelisted');

    return this.prisma.ipWhitelist.create({
      data: {
        userId,
        ipAddress: data.ipAddress,
        label: data.label || null,
        isActive: true,
        expiresAt: data.expiresAt || null,
        reference: `IPW-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getIps(userId: string) {
    return this.prisma.ipWhitelist.findMany({ where: { userId } });
  }

  async removeIp(userId: string, id: string) {
    const entry = await this.prisma.ipWhitelist.findUnique({ where: { id } });
    if (!entry) throw new Error('ip_entry_not_found');
    if ((entry as any).userId !== userId) throw new Error('ip_entry_not_found');
    return this.prisma.ipWhitelist.delete({ where: { id } });
  }

  async toggleIp(userId: string, id: string, active: boolean) {
    const entry = await this.prisma.ipWhitelist.findUnique({ where: { id } });
    if (!entry) throw new Error('ip_entry_not_found');
    if ((entry as any).userId !== userId) throw new Error('ip_entry_not_found');
    return this.prisma.ipWhitelist.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async checkIp(userId: string, ipAddress: string) {
    const entries = await this.prisma.ipWhitelist.findMany({ where: { userId } });
    const active = (entries as any[]).filter((e) => e.isActive);
    if (active.length === 0) return { whitelistEnabled: false, allowed: true };

    const now = new Date();
    const validEntries = active.filter(
      (e) => !e.expiresAt || new Date(e.expiresAt) > now,
    );
    const match = validEntries.find((e) => e.ipAddress === ipAddress);
    return { whitelistEnabled: true, allowed: !!match };
  }

  async getIpWhitelistAnalytics(userId: string) {
    const entries = await this.prisma.ipWhitelist.findMany({ where: { userId } });

    if (entries.length === 0) {
      return {
        totalEntries: 0,
        activeEntries: 0,
        whitelistEnabled: false,
        analyticsLevel: 'no_data',
      };
    }

    const active = (entries as any[]).filter((e) => e.isActive).length;
    const now = new Date();
    const expiring = (entries as any[]).filter(
      (e) => e.isActive && e.expiresAt && new Date(e.expiresAt).getTime() - now.getTime() < 7 * 24 * 60 * 60 * 1000,
    ).length;

    return {
      totalEntries: entries.length,
      activeEntries: active,
      expiringEntries: expiring,
      whitelistEnabled: active > 0,
      analyticsLevel: active > 0 ? 'secured' : 'inactive',
    };
  }
}
