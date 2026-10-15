import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class RateLimitConfigService {
  constructor(private prisma: PrismaClient) {}

  async setLimit(userId: string, data: {
    endpoint: string;
    maxRequests: number;
    windowSeconds: number;
    strategy?: string;
  }) {
    const existing = await this.prisma.rateLimitConfig.findFirst({
      where: { userId, endpoint: data.endpoint },
    });

    if (existing) {
      return this.prisma.rateLimitConfig.update({
        where: { id: (existing as any).id },
        data: {
          maxRequests: data.maxRequests,
          windowSeconds: data.windowSeconds,
          strategy: data.strategy || 'fixed_window',
        },
      });
    }

    return this.prisma.rateLimitConfig.create({
      data: {
        userId,
        endpoint: data.endpoint,
        maxRequests: data.maxRequests,
        windowSeconds: data.windowSeconds,
        strategy: data.strategy || 'fixed_window',
        isActive: true,
        reference: `RLC-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getLimits(userId: string) {
    return this.prisma.rateLimitConfig.findMany({ where: { userId } });
  }

  async getLimit(userId: string, id: string) {
    const limit = await this.prisma.rateLimitConfig.findUnique({ where: { id } });
    if (!limit) throw new Error('rate_limit_not_found');
    if ((limit as any).userId !== userId) throw new Error('rate_limit_not_found');
    return limit;
  }

  async removeLimit(userId: string, id: string) {
    await this.getLimit(userId, id);
    return this.prisma.rateLimitConfig.delete({ where: { id } });
  }

  async toggleLimit(userId: string, id: string, active: boolean) {
    await this.getLimit(userId, id);
    return this.prisma.rateLimitConfig.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async checkLimit(userId: string, endpoint: string) {
    const configs = await this.prisma.rateLimitConfig.findMany({ where: { userId } });
    const config = (configs as any[]).find(
      (c) => c.endpoint === endpoint && c.isActive,
    );
    if (!config) return { limited: false, config: null };

    return {
      limited: true,
      config: {
        maxRequests: config.maxRequests,
        windowSeconds: config.windowSeconds,
        strategy: config.strategy,
      },
    };
  }

  async getRateLimitAnalytics(userId: string) {
    const configs = await this.prisma.rateLimitConfig.findMany({ where: { userId } });

    if (configs.length === 0) {
      return {
        totalConfigs: 0,
        activeConfigs: 0,
        endpoints: [],
        strategies: {},
        analyticsLevel: 'no_data',
      };
    }

    const active = (configs as any[]).filter((c) => c.isActive).length;
    const endpoints = (configs as any[]).map((c) => c.endpoint);
    const strategies: Record<string, number> = {};
    for (const c of configs as any[]) {
      strategies[c.strategy] = (strategies[c.strategy] || 0) + 1;
    }

    return {
      totalConfigs: configs.length,
      activeConfigs: active,
      endpoints,
      strategies,
      analyticsLevel: active > 0 ? 'configured' : 'inactive',
    };
  }
}
