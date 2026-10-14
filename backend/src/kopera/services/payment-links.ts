import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

export class PaymentLinkService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    amount: bigint;
    currency: string;
    description?: string;
    expiresAt?: Date;
    singleUse?: boolean;
  }) {
    const code = randomBytes(12).toString('base64url');

    return this.prisma.paymentLink.create({
      data: {
        userId: params.userId,
        code,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        description: params.description ?? null,
        status: 'active',
        singleUse: params.singleUse ?? true,
        expiresAt: params.expiresAt ?? null,
        timesUsed: 0,
      },
    });
  }

  async getByCode(code: string) {
    const link = await this.prisma.paymentLink.findFirst({ where: { code } });
    if (!link) return null;
    if (link.status !== 'active') return link;
    if (link.expiresAt && link.expiresAt < new Date()) {
      await this.prisma.paymentLink.update({
        where: { id: link.id },
        data: { status: 'expired' },
      });
      return { ...link, status: 'expired' };
    }
    return link;
  }

  async getById(id: string) {
    return this.prisma.paymentLink.findUnique({ where: { id } });
  }

  async listByUser(userId: string, opts?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = { userId };
    if (opts?.status) where.status = opts.status;
    return this.prisma.paymentLink.findMany({
      where,
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async markUsed(id: string) {
    const link = await this.prisma.paymentLink.findUnique({ where: { id } });
    if (!link) throw new Error('link_not_found');
    if (link.status !== 'active') throw new Error('link_not_active');

    return this.prisma.paymentLink.update({
      where: { id },
      data: {
        timesUsed: link.timesUsed + 1,
        lastUsedAt: new Date(),
        status: link.singleUse ? 'used' : 'active',
      },
    });
  }

  async getAnalytics(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });
    let totalCollected = BigInt(0);
    let totalTimesUsed = 0;
    const byStatus: Record<string, number> = {};

    for (const l of links) {
      byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
      totalTimesUsed += l.timesUsed;
      if (l.timesUsed > 0) {
        totalCollected += l.amount * BigInt(l.timesUsed);
      }
    }

    return {
      totalLinks: links.length,
      totalCollected,
      totalTimesUsed,
      byStatus,
    };
  }

  async getExpiringSoon(userId: string, withinDays: number = 7) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });
    const now = new Date();
    const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

    return links
      .filter((l: any) => l.status === 'active' && l.expiresAt && l.expiresAt > now && l.expiresAt <= cutoff)
      .map((l: any) => ({
        id: l.id,
        code: l.code,
        amount: l.amount,
        currency: l.currency,
        description: l.description,
        expiresAt: l.expiresAt,
        daysRemaining: Math.ceil((l.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
        timesUsed: l.timesUsed,
      }))
      .sort((a: any, b: any) => a.daysRemaining - b.daysRemaining);
  }

  async getConversionReport(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });

    let usedCount = 0;
    let totalRevenue = BigInt(0);
    let topLink: { id: string; code: string; amount: bigint; currency: string; timesUsed: number } | null = null;

    for (const l of links) {
      if (l.timesUsed > 0) {
        usedCount++;
        totalRevenue += l.amount * BigInt(l.timesUsed);
        if (!topLink || l.timesUsed > topLink.timesUsed) {
          topLink = { id: l.id, code: l.code, amount: l.amount, currency: l.currency, timesUsed: l.timesUsed };
        }
      }
    }

    const conversionRate = links.length > 0
      ? Math.round(usedCount / links.length * 10000) / 100
      : 0;
    const avgRevenuePerLink = links.length > 0
      ? totalRevenue / BigInt(links.length)
      : BigInt(0);

    return {
      totalLinks: links.length,
      usedCount,
      conversionRate,
      totalRevenue,
      avgRevenuePerLink,
      topPerformingLink: topLink,
    };
  }

  async getRevenueBreakdown(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });

    const byCurrency: Record<string, { links: number; revenue: bigint; timesUsed: number }> = {};
    let singleUseRevenue = BigInt(0);
    let multiUseRevenue = BigInt(0);
    let singleUseCount = 0;
    let multiUseCount = 0;
    let totalRevenue = BigInt(0);
    let activeRevenue = BigInt(0);
    let expiredRevenue = BigInt(0);

    for (const l of links) {
      const rev = l.amount * BigInt(l.timesUsed);
      totalRevenue += rev;

      if (!byCurrency[l.currency]) byCurrency[l.currency] = { links: 0, revenue: BigInt(0), timesUsed: 0 };
      byCurrency[l.currency].links++;
      byCurrency[l.currency].revenue += rev;
      byCurrency[l.currency].timesUsed += l.timesUsed;

      if (l.singleUse) {
        singleUseCount++;
        singleUseRevenue += rev;
      } else {
        multiUseCount++;
        multiUseRevenue += rev;
      }

      if (l.status === 'active') activeRevenue += rev;
      else if (l.status === 'expired') expiredRevenue += rev;
    }

    const currencyBreakdown: Record<string, { links: number; revenue: string; timesUsed: number }> = {};
    for (const [cur, data] of Object.entries(byCurrency)) {
      currencyBreakdown[cur] = { links: data.links, revenue: data.revenue.toString(), timesUsed: data.timesUsed };
    }

    return {
      totalLinks: links.length,
      totalRevenue,
      byCurrency: currencyBreakdown,
      singleUse: { count: singleUseCount, revenue: singleUseRevenue },
      multiUse: { count: multiUseCount, revenue: multiUseRevenue },
      activeRevenue,
      expiredRevenue,
    };
  }

  async getLifecycleAnalysis(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });

    let usedCount = 0;
    let expiredUnusedCount = 0;
    let activeCount = 0;
    let deactivatedCount = 0;
    let totalTimeToFirstUseMs = 0;
    let usedWithTimeCount = 0;
    let totalLifespanMs = 0;
    let lifespanCount = 0;
    const byCurrency: Record<string, { count: number; totalAmount: bigint; usedCount: number }> = {};

    for (const l of links) {
      if (!byCurrency[l.currency]) byCurrency[l.currency] = { count: 0, totalAmount: BigInt(0), usedCount: 0 };
      byCurrency[l.currency].count++;
      byCurrency[l.currency].totalAmount += l.amount;

      if (l.timesUsed > 0) {
        usedCount++;
        byCurrency[l.currency].usedCount++;
        if ((l as any).lastUsedAt && l.createdAt) {
          totalTimeToFirstUseMs += new Date((l as any).lastUsedAt).getTime() - new Date(l.createdAt).getTime();
          usedWithTimeCount++;
        }
      }

      if (l.status === 'expired' && l.timesUsed === 0) expiredUnusedCount++;
      if (l.status === 'active') activeCount++;
      if (l.status === 'deactivated') deactivatedCount++;

      if (l.expiresAt && l.createdAt) {
        totalLifespanMs += new Date(l.expiresAt).getTime() - new Date(l.createdAt).getTime();
        lifespanCount++;
      }
    }

    const abandonmentRate = links.length > 0
      ? Math.round((expiredUnusedCount / links.length) * 10000) / 100
      : 0;
    const avgTimeToFirstUseMs = usedWithTimeCount > 0
      ? Math.round(totalTimeToFirstUseMs / usedWithTimeCount)
      : null;
    const avgLifespanDays = lifespanCount > 0
      ? Math.round(totalLifespanMs / lifespanCount / (1000 * 60 * 60 * 24) * 10) / 10
      : null;

    const currencyBreakdown = Object.entries(byCurrency).map(([currency, data]) => ({
      currency,
      count: data.count,
      totalAmount: data.totalAmount.toString(),
      usedCount: data.usedCount,
      conversionRate: data.count > 0 ? Math.round((data.usedCount / data.count) * 10000) / 100 : 0,
    }));

    return {
      totalLinks: links.length,
      activeCount,
      usedCount,
      expiredUnusedCount,
      deactivatedCount,
      abandonmentRate,
      avgTimeToFirstUseMs,
      avgLifespanDays,
      currencyBreakdown,
    };
  }

  async getAmountTierAnalysis(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });

    const tiers: Record<string, { links: number; used: number; totalAmount: bigint; totalUsed: number }> = {
      micro: { links: 0, used: 0, totalAmount: BigInt(0), totalUsed: 0 },
      small: { links: 0, used: 0, totalAmount: BigInt(0), totalUsed: 0 },
      medium: { links: 0, used: 0, totalAmount: BigInt(0), totalUsed: 0 },
      large: { links: 0, used: 0, totalAmount: BigInt(0), totalUsed: 0 },
    };

    for (const l of links) {
      const amt = Number(l.amount);
      const tier = amt < 1000 ? 'micro' : amt < 10000 ? 'small' : amt < 100000 ? 'medium' : 'large';
      tiers[tier].links++;
      tiers[tier].totalAmount += l.amount;
      tiers[tier].totalUsed += l.timesUsed;
      if (l.timesUsed > 0) tiers[tier].used++;
    }

    const result: Record<string, { links: number; used: number; conversionRate: number; totalAmount: string; totalUsed: number; avgAmount: string }> = {};
    for (const [tier, data] of Object.entries(tiers)) {
      result[tier] = {
        links: data.links,
        used: data.used,
        conversionRate: data.links > 0 ? Math.round((data.used / data.links) * 10000) / 100 : 0,
        totalAmount: data.totalAmount.toString(),
        totalUsed: data.totalUsed,
        avgAmount: data.links > 0 ? (data.totalAmount / BigInt(data.links)).toString() : '0',
      };
    }

    let bestTier: string | null = null;
    let bestRate = 0;
    for (const [tier, data] of Object.entries(result)) {
      if (data.links > 0 && data.conversionRate > bestRate) {
        bestTier = tier;
        bestRate = data.conversionRate;
      }
    }

    return {
      totalLinks: links.length,
      tiers: result,
      bestPerformingTier: bestTier,
      bestConversionRate: bestRate,
    };
  }

  async getUsageVelocity(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });

    if (links.length === 0) {
      return {
        totalLinks: 0,
        totalUsed: 0,
        byDay: [] as Array<{ day: string; created: number; used: number }>,
        avgCreatedPerWeek: 0,
        avgUsedPerWeek: 0,
        peakDay: null as string | null,
        adoptionTrend: 'none' as const,
      };
    }

    const dayMap = new Map<string, { created: number; used: number }>();

    for (const l of links) {
      const createDay = new Date(l.createdAt).toISOString().slice(0, 10);
      const entry = dayMap.get(createDay) ?? { created: 0, used: 0 };
      entry.created++;
      dayMap.set(createDay, entry);

      if (l.timesUsed > 0 && (l as any).lastUsedAt) {
        const useDay = new Date((l as any).lastUsedAt).toISOString().slice(0, 10);
        const useEntry = dayMap.get(useDay) ?? { created: 0, used: 0 };
        useEntry.used += l.timesUsed;
        dayMap.set(useDay, useEntry);
      }
    }

    const byDay = Array.from(dayMap.entries())
      .map(([day, data]) => ({ day, created: data.created, used: data.used }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const totalUsed = links.reduce((s, l) => s + l.timesUsed, 0);
    const days = byDay.length;
    const weeks = Math.max(1, days / 7);
    const avgCreatedPerWeek = Math.round((links.length / weeks) * 100) / 100;
    const avgUsedPerWeek = Math.round((totalUsed / weeks) * 100) / 100;

    const peakEntry = byDay.reduce((best, d) => (d.created + d.used) > (best.created + best.used) ? d : best, byDay[0]);
    const peakDay = peakEntry ? peakEntry.day : null;

    let adoptionTrend: 'accelerating' | 'stable' | 'declining' | 'none' = 'none';
    if (byDay.length >= 4) {
      const half = Math.floor(byDay.length / 2);
      const firstHalf = byDay.slice(0, half).reduce((s, d) => s + d.created, 0) / half;
      const secondHalf = byDay.slice(half).reduce((s, d) => s + d.created, 0) / (byDay.length - half);
      const change = firstHalf > 0 ? (secondHalf - firstHalf) / firstHalf : 0;
      adoptionTrend = change > 0.2 ? 'accelerating' : change < -0.2 ? 'declining' : 'stable';
    }

    return {
      totalLinks: links.length,
      totalUsed,
      byDay,
      avgCreatedPerWeek,
      avgUsedPerWeek,
      peakDay,
      adoptionTrend,
    };
  }

  async getExpirationImpactAnalysis(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });

    const expired = links.filter((l) => l.status === 'expired' || (l.expiresAt && l.expiresAt < new Date()));
    const used = links.filter((l) => l.usedAt !== null && l.usedAt !== undefined);
    const active = links.filter((l) => l.status === 'active' && !l.usedAt && (!l.expiresAt || l.expiresAt >= new Date()));
    const deactivated = links.filter((l) => l.status === 'deactivated');

    const usedTimes = used.map((l) => {
      const created = new Date(l.createdAt).getTime();
      const usedTime = new Date(l.usedAt!).getTime();
      return (usedTime - created) / 3600000;
    }).filter((h) => h >= 0);
    const avgHoursToUse = usedTimes.length > 0
      ? Math.round(usedTimes.reduce((s, v) => s + v, 0) / usedTimes.length * 10) / 10
      : 0;

    const expiredWithAmount = expired.filter((l) => l.amount !== null && l.amount !== undefined);
    const lostRevenue = expiredWithAmount.reduce((s, l) => s + Number(l.amount), 0);

    const linksWithExpiry = links.filter((l) => l.expiresAt);
    const usedBeforeExpiry = linksWithExpiry.filter((l) => l.usedAt && l.usedAt <= (l.expiresAt ?? new Date()));
    const conversionBeforeExpiry = linksWithExpiry.length > 0
      ? Math.round((usedBeforeExpiry.length / linksWithExpiry.length) * 100)
      : 0;

    return {
      totalLinks: links.length,
      expired: expired.length,
      used: used.length,
      active: active.length,
      deactivated: deactivated.length,
      expirationRate: links.length > 0 ? Math.round((expired.length / links.length) * 100) : 0,
      avgHoursToUse,
      lostRevenue: lostRevenue.toString(),
      conversionBeforeExpiry,
    };
  }

  async deactivate(id: string, userId: string) {
    const link = await this.prisma.paymentLink.findUnique({ where: { id } });
    if (!link) throw new Error('link_not_found');
    if (link.userId !== userId) throw new Error('forbidden');
    if (link.status === 'deactivated') throw new Error('already_deactivated');

    return this.prisma.paymentLink.update({
      where: { id },
      data: { status: 'deactivated' },
    });
  }

  async getPaymentLinkAbandonmentAnalysis(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });
    if (links.length === 0) {
      return {
        totalLinks: 0,
        abandonedCount: 0,
        abandonmentRate: 0,
        usedCount: 0,
        avgTimesToUsed: '0',
        byStatus: [],
        abandonedValue: '0',
      };
    }

    const abandoned = links.filter((l: any) => l.timesUsed === 0 && l.status !== 'deactivated');
    const used = links.filter((l: any) => l.timesUsed > 0);
    const deactivated = links.filter((l: any) => l.status === 'deactivated');

    const statusMap = new Map<string, number>();
    for (const l of links) {
      const s = (l as any).status || 'unknown';
      statusMap.set(s, (statusMap.get(s) || 0) + 1);
    }

    let abandonedValue = BigInt(0);
    for (const l of abandoned) {
      abandonedValue += BigInt((l as any).amount || 0);
    }

    const usageTimes: number[] = [];
    for (const l of used) {
      if ((l as any).lastUsedAt && l.createdAt) {
        const diff = new Date((l as any).lastUsedAt).getTime() - new Date(l.createdAt).getTime();
        if (diff > 0) usageTimes.push(diff);
      }
    }
    const avgTimeToUsed = usageTimes.length > 0
      ? Math.round(usageTimes.reduce((a, b) => a + b, 0) / usageTimes.length / 3600000)
      : 0;

    return {
      totalLinks: links.length,
      abandonedCount: abandoned.length,
      abandonmentRate: Number((abandoned.length / links.length).toFixed(4)),
      usedCount: used.length,
      deactivatedCount: deactivated.length,
      avgTimeToUsedHours: avgTimeToUsed,
      byStatus: Array.from(statusMap.entries()).map(([status, count]) => ({ status, count })),
      abandonedValue: abandonedValue.toString(),
    };
  }

  async getPaymentLinkRecurrenceAnalysis(userId: string) {
    const links = await this.prisma.paymentLink.findMany({ where: { userId } });

    if (links.length === 0) {
      return {
        totalLinks: 0,
        singleUseCount: 0,
        multiUseCount: 0,
        reuseRate: 0,
        avgUsesPerLink: 0,
        topReusedLinks: [] as { id: string; code: string; useCount: number }[],
        recommendations: [] as string[],
      };
    }

    let singleUseCount = 0;
    let multiUseCount = 0;
    let totalUses = 0;
    const reusedLinks: { id: string; code: string; useCount: number }[] = [];

    for (const l of links) {
      const useCount = (l as any).useCount ?? ((l as any).status === 'USED' ? 1 : 0);
      totalUses += useCount;
      if (useCount > 1) {
        multiUseCount++;
        reusedLinks.push({ id: l.id, code: (l as any).code || '', useCount });
      } else if (useCount === 1) {
        singleUseCount++;
      }
    }

    reusedLinks.sort((a, b) => b.useCount - a.useCount);

    const reuseRate = links.length > 0
      ? Number((multiUseCount / links.length).toFixed(4))
      : 0;
    const avgUsesPerLink = links.length > 0
      ? Number((totalUses / links.length).toFixed(2))
      : 0;

    const recommendations: string[] = [];
    if (reuseRate < 0.1) recommendations.push('Consider creating reusable payment links for recurring payments');
    if (singleUseCount > multiUseCount * 5) recommendations.push('High single-use ratio — evaluate if multi-use links could reduce management overhead');
    if (avgUsesPerLink < 1.5) recommendations.push('Low average usage per link — review link distribution strategy');

    return {
      totalLinks: links.length,
      singleUseCount,
      multiUseCount,
      reuseRate,
      avgUsesPerLink,
      topReusedLinks: reusedLinks.slice(0, 5),
      recommendations,
    };
  }
}
