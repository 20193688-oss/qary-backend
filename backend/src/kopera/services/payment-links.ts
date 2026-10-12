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
}
