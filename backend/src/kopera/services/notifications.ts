import type { PrismaClient } from '@prisma/client';

export class NotificationService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    type: string;
    channel: string;
    subject?: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type as any,
        channel: params.channel,
        subject: params.subject,
        body: params.body,
        metadata: params.metadata as any,
        sentAt: new Date(),
      },
    });
  }

  async listByUser(userId: string, opts: { limit?: number; offset?: number; unreadOnly?: boolean; type?: string; channel?: string } = {}) {
    const where: Record<string, unknown> = { userId };
    if (opts.unreadOnly) where.readAt = null;
    if (opts.type) where.type = opts.type;
    if (opts.channel) where.channel = opts.channel;
    return this.prisma.notification.findMany({
      where,
      take: Math.min(opts.limit ?? 20, 100),
      skip: opts.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async markAsRead(userId: string, notificationId: string) {
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!n) throw new Error('notification_not_found');
    if (n.userId !== userId) throw new Error('forbidden');
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async unreadCount(userId: string) {
    return this.prisma.notification.count({
      where: { userId, readAt: null },
    });
  }

  async getById(id: string) {
    return this.prisma.notification.findUnique({ where: { id } });
  }

  async markDelivered(id: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new Error('notification_not_found');
    if (n.deliveredAt) throw new Error('already_delivered');

    return this.prisma.notification.update({
      where: { id },
      data: { deliveredAt: new Date() },
    });
  }

  async markFailed(id: string, reason: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new Error('notification_not_found');

    return this.prisma.notification.update({
      where: { id },
      data: { failedAt: new Date(), failReason: reason },
    });
  }

  async getStats(userId: string) {
    const all = await this.prisma.notification.findMany({ where: { userId } });
    const byType: Record<string, number> = {};
    const byChannel: Record<string, number> = {};
    let readCount = 0;
    let unreadCount = 0;
    let deliveredCount = 0;
    let failedCount = 0;

    for (const n of all) {
      byType[n.type] = (byType[n.type] ?? 0) + 1;
      byChannel[n.channel] = (byChannel[n.channel] ?? 0) + 1;
      if (n.readAt) readCount++; else unreadCount++;
      if (n.deliveredAt) deliveredCount++;
      if (n.failedAt) failedCount++;
    }

    return { total: all.length, readCount, unreadCount, deliveredCount, failedCount, byType, byChannel };
  }

  async getDeliveryReport(userId: string) {
    const all = await this.prisma.notification.findMany({ where: { userId } });
    const byChannel: Record<string, { total: number; delivered: number; failed: number; read: number }> = {};
    const failReasons: Record<string, number> = {};
    let totalReadTimeMs = 0;
    let readWithTimeCount = 0;

    for (const n of all) {
      if (!byChannel[n.channel]) byChannel[n.channel] = { total: 0, delivered: 0, failed: 0, read: 0 };
      byChannel[n.channel].total++;
      if (n.deliveredAt) byChannel[n.channel].delivered++;
      if (n.failedAt) {
        byChannel[n.channel].failed++;
        if ((n as any).failReason) {
          failReasons[(n as any).failReason] = (failReasons[(n as any).failReason] ?? 0) + 1;
        }
      }
      if (n.readAt) {
        byChannel[n.channel].read++;
        if (n.sentAt) {
          totalReadTimeMs += new Date(n.readAt).getTime() - new Date(n.sentAt).getTime();
          readWithTimeCount++;
        }
      }
    }

    const total = all.length;
    const delivered = all.filter(n => n.deliveredAt).length;
    const failed = all.filter(n => n.failedAt).length;
    const read = all.filter(n => n.readAt).length;

    return {
      total,
      deliveryRate: total > 0 ? Math.round((delivered / total) * 100) : 0,
      failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
      readRate: delivered > 0 ? Math.round((read / delivered) * 100) : 0,
      avgReadTimeMs: readWithTimeCount > 0 ? Math.round(totalReadTimeMs / readWithTimeCount) : null,
      byChannel,
      topFailReasons: failReasons,
    };
  }

  async getEngagementReport(userId: string) {
    const all = await this.prisma.notification.findMany({ where: { userId } });
    const byType: Record<string, { sent: number; read: number; avgReadTimeMs: number; totalReadTimeMs: number }> = {};
    const byChannel: Record<string, { sent: number; read: number; delivered: number }> = {};
    const hourBuckets: Record<number, number> = {};

    for (const n of all) {
      const type = n.type;
      if (!byType[type]) byType[type] = { sent: 0, read: 0, avgReadTimeMs: 0, totalReadTimeMs: 0 };
      byType[type].sent++;

      const ch = n.channel;
      if (!byChannel[ch]) byChannel[ch] = { sent: 0, read: 0, delivered: 0 };
      byChannel[ch].sent++;
      if (n.deliveredAt) byChannel[ch].delivered++;

      if (n.readAt) {
        byType[type].read++;
        byChannel[ch].read++;
        if (n.sentAt) {
          byType[type].totalReadTimeMs += new Date(n.readAt).getTime() - new Date(n.sentAt).getTime();
        }
        const hour = new Date(n.readAt).getUTCHours();
        hourBuckets[hour] = (hourBuckets[hour] ?? 0) + 1;
      }
    }

    for (const data of Object.values(byType)) {
      data.avgReadTimeMs = data.read > 0 ? Math.round(data.totalReadTimeMs / data.read) : 0;
    }

    const typeEngagement: Record<string, { sent: number; read: number; readRate: number; avgReadTimeMs: number }> = {};
    for (const [type, data] of Object.entries(byType)) {
      typeEngagement[type] = {
        sent: data.sent,
        read: data.read,
        readRate: data.sent > 0 ? Math.round((data.read / data.sent) * 10000) / 100 : 0,
        avgReadTimeMs: data.avgReadTimeMs,
      };
    }

    const channelEngagement: Record<string, { sent: number; read: number; delivered: number; readRate: number }> = {};
    for (const [ch, data] of Object.entries(byChannel)) {
      channelEngagement[ch] = {
        sent: data.sent,
        read: data.read,
        delivered: data.delivered,
        readRate: data.sent > 0 ? Math.round((data.read / data.sent) * 10000) / 100 : 0,
      };
    }

    const peakHours = Object.entries(hourBuckets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour, count]) => ({ hour: Number(hour), readCount: count }));

    const totalRead = all.filter(n => n.readAt).length;
    const overallReadRate = all.length > 0 ? Math.round((totalRead / all.length) * 10000) / 100 : 0;

    return {
      totalNotifications: all.length,
      totalRead,
      overallReadRate,
      byType: typeEngagement,
      byChannel: channelEngagement,
      peakEngagementHours: peakHours,
    };
  }

  async getChannelEffectiveness(userId: string) {
    const all = await this.prisma.notification.findMany({ where: { userId } });

    const channels: Record<string, {
      total: number; delivered: number; failed: number; read: number;
      totalReadTimeMs: number; readWithTime: number;
    }> = {};

    for (const n of all) {
      const ch = n.channel;
      if (!channels[ch]) channels[ch] = { total: 0, delivered: 0, failed: 0, read: 0, totalReadTimeMs: 0, readWithTime: 0 };
      channels[ch].total++;
      if (n.deliveredAt) channels[ch].delivered++;
      if (n.failedAt) channels[ch].failed++;
      if (n.readAt) {
        channels[ch].read++;
        if (n.sentAt) {
          channels[ch].totalReadTimeMs += new Date(n.readAt).getTime() - new Date(n.sentAt).getTime();
          channels[ch].readWithTime++;
        }
      }
    }

    const channelScores: Array<{
      channel: string; total: number; deliveryRate: number; readRate: number;
      avgReadTimeMs: number | null; effectivenessScore: number;
    }> = [];

    for (const [channel, data] of Object.entries(channels)) {
      const deliveryRate = data.total > 0 ? Math.round((data.delivered / data.total) * 10000) / 100 : 0;
      const readRate = data.total > 0 ? Math.round((data.read / data.total) * 10000) / 100 : 0;
      const avgReadTimeMs = data.readWithTime > 0 ? Math.round(data.totalReadTimeMs / data.readWithTime) : null;
      const effectivenessScore = Math.round((deliveryRate * 0.4 + readRate * 0.6) * 100) / 100;

      channelScores.push({ channel, total: data.total, deliveryRate, readRate, avgReadTimeMs, effectivenessScore });
    }

    channelScores.sort((a, b) => b.effectivenessScore - a.effectivenessScore);

    const recommendations: string[] = [];
    for (const cs of channelScores) {
      if (cs.deliveryRate < 50) recommendations.push(`${cs.channel} has low delivery rate (${cs.deliveryRate}%) — check configuration`);
      if (cs.readRate < 20 && cs.total > 5) recommendations.push(`${cs.channel} has low read rate (${cs.readRate}%) — consider reducing volume`);
    }

    const bestChannel = channelScores.length > 0 ? channelScores[0].channel : null;

    return {
      totalNotifications: all.length,
      channelCount: channelScores.length,
      channels: channelScores,
      bestChannel,
      recommendations,
    };
  }

  async getNotificationFatigue(userId: string) {
    const notifications = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (notifications.length === 0) {
      return {
        totalNotifications: 0,
        overallReadRate: 0,
        fatigueLevel: 'none' as string,
        weeklyTrend: [] as Array<{ week: string; sent: number; read: number; readRate: number }>,
        decliningTypes: [] as string[],
        recommendations: [] as string[],
      };
    }

    const totalRead = notifications.filter(n => n.readAt).length;
    const overallReadRate = Math.round((totalRead / notifications.length) * 10000) / 100;

    const byWeek: Record<string, { sent: number; read: number }> = {};
    const byType: Record<string, { sent: number; read: number; recent: { sent: number; read: number } }> = {};
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    for (const n of notifications) {
      const d = n.createdAt;
      const weekStart = new Date(d);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekKey = `${weekStart.getFullYear()}-W${String(Math.ceil((weekStart.getDate()) / 7)).padStart(2, '0')}`;

      if (!byWeek[weekKey]) byWeek[weekKey] = { sent: 0, read: 0 };
      byWeek[weekKey].sent++;
      if (n.readAt) byWeek[weekKey].read++;

      const type = n.type;
      if (!byType[type]) byType[type] = { sent: 0, read: 0, recent: { sent: 0, read: 0 } };
      byType[type].sent++;
      if (n.readAt) byType[type].read++;
      if (d.getTime() > thirtyDaysAgo) {
        byType[type].recent.sent++;
        if (n.readAt) byType[type].recent.read++;
      }
    }

    const weeklyTrend = Object.entries(byWeek)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, data]) => ({
        week,
        sent: data.sent,
        read: data.read,
        readRate: Math.round((data.read / data.sent) * 10000) / 100,
      }));

    const decliningTypes: string[] = [];
    for (const [type, data] of Object.entries(byType)) {
      if (data.sent >= 3 && data.recent.sent >= 1) {
        const overallRate = data.read / data.sent;
        const recentRate = data.recent.sent > 0 ? data.recent.read / data.recent.sent : 0;
        if (recentRate < overallRate * 0.7) decliningTypes.push(type);
      }
    }

    const recommendations: string[] = [];
    if (overallReadRate < 30) recommendations.push('Consider reducing notification volume');
    if (decliningTypes.length > 0) recommendations.push(`Review frequency for: ${decliningTypes.join(', ')}`);
    if (notifications.length > 100 && overallReadRate < 50) recommendations.push('Enable notification batching');

    const fatigueLevel = overallReadRate < 20 ? 'high'
      : overallReadRate < 50 ? 'medium'
      : 'low';

    return {
      totalNotifications: notifications.length,
      overallReadRate,
      fatigueLevel,
      weeklyTrend,
      decliningTypes,
      recommendations,
    };
  }

  async deleteAllRead(userId: string) {
    return this.prisma.notification.deleteMany({
      where: { userId, readAt: { not: null } },
    });
  }

  async getTypeEffectiveness(userId: string) {
    const all = await this.prisma.notification.findMany({ where: { userId } });

    if (all.length === 0) {
      return {
        totalNotifications: 0,
        byType: [] as Array<{ type: string; total: number; delivered: number; read: number; deliveryRate: number; readRate: number; avgReadTimeMs: number | null; effectivenessScore: number }>,
        bestType: null as string | null,
        worstType: null as string | null,
      };
    }

    const typeMap = new Map<string, { total: number; delivered: number; read: number; failed: number; readTimeMs: number; readWithTime: number }>();

    for (const n of all) {
      const entry = typeMap.get(n.type) ?? { total: 0, delivered: 0, read: 0, failed: 0, readTimeMs: 0, readWithTime: 0 };
      entry.total++;
      if (n.deliveredAt) entry.delivered++;
      if (n.failedAt) entry.failed++;
      if (n.readAt) {
        entry.read++;
        if (n.sentAt) {
          entry.readTimeMs += new Date(n.readAt).getTime() - new Date(n.sentAt).getTime();
          entry.readWithTime++;
        }
      }
      typeMap.set(n.type, entry);
    }

    const byType = Array.from(typeMap.entries()).map(([type, data]) => {
      const deliveryRate = data.total > 0 ? Math.round((data.delivered / data.total) * 10000) / 100 : 0;
      const readRate = data.delivered > 0 ? Math.round((data.read / data.delivered) * 10000) / 100 : 0;
      const failureRate = data.total > 0 ? Math.round((data.failed / data.total) * 10000) / 100 : 0;
      const avgReadTimeMs = data.readWithTime > 0 ? Math.round(data.readTimeMs / data.readWithTime) : null;
      const effectivenessScore = Math.round((deliveryRate * 0.4 + readRate * 0.4 + (100 - failureRate) * 0.2) * 100) / 100;

      return { type, total: data.total, delivered: data.delivered, read: data.read, deliveryRate, readRate, avgReadTimeMs, effectivenessScore };
    }).sort((a, b) => b.effectivenessScore - a.effectivenessScore);

    return {
      totalNotifications: all.length,
      byType,
      bestType: byType[0]?.type ?? null,
      worstType: byType.length > 1 ? byType[byType.length - 1].type : null,
    };
  }

  async delete(id: string, userId: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new Error('notification_not_found');
    if (n.userId !== userId) throw new Error('forbidden');

    return this.prisma.notification.delete({ where: { id } });
  }
}
