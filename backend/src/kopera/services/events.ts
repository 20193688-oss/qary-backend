import type { PrismaClient, AlertSeverity, Prisma } from '@prisma/client';

export class EventService {
  constructor(private prisma: PrismaClient) {}

  async log(data: {
    userId?: string;
    actor: string;
    eventType: string;
    payload: Prisma.InputJsonValue;
    requestId?: string;
    ip?: string;
    userAgent?: string;
    agentId?: string;
    severity?: AlertSeverity;
  }) {
    return this.prisma.event.create({
      data: data as any,
    });
  }

  async list(filters: {
    userId?: string;
    eventType?: string;
    actor?: string;
    severity?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (filters.userId) where.userId = filters.userId;
    if (filters.eventType) where.eventType = filters.eventType;
    if (filters.actor) where.actor = filters.actor;
    if (filters.severity) where.severity = filters.severity;
    if (filters.from || filters.to) {
      const createdAt: Record<string, Date> = {};
      if (filters.from) createdAt.gte = new Date(filters.from);
      if (filters.to) createdAt.lte = new Date(filters.to);
      where.createdAt = createdAt;
    }

    return this.prisma.event.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 50,
      skip: filters.offset ?? 0,
    });
  }

  async getById(id: string) {
    return this.prisma.event.findUnique({ where: { id } });
  }

  async countByType(userId?: string) {
    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    const events = await this.prisma.event.findMany({ where });

    const byEventType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byActor: Record<string, number> = {};

    for (const e of events) {
      byEventType[e.eventType] = (byEventType[e.eventType] ?? 0) + 1;
      if (e.severity) bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
      byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;
    }

    return { totalEvents: events.length, byEventType, bySeverity, byActor };
  }

  async getActivityTimeline(userId: string, days = 30) {
    const events = await this.prisma.event.findMany({ where: { userId } });

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recent = events.filter((e: any) => new Date(e.createdAt) >= cutoff);

    const byDay: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const e of recent) {
      const day = new Date(e.createdAt).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
      byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
    }

    const topTypes = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([type, count]) => ({ type, count }));

    return {
      totalEvents: recent.length,
      days,
      byDay,
      topEventTypes: topTypes,
    };
  }

  async getSecurityAudit(userId: string) {
    const events = await this.prisma.event.findMany({ where: { userId } });

    const securityTypes = ['auth.login', 'auth.logout', 'auth.failed', 'auth.mfa_enabled', 'auth.mfa_disabled',
      'auth.password_changed', 'auth.pin_set', 'auth.pin_changed', 'session.revoked', 'session.created'];
    const securityEvents = events.filter((e: any) => securityTypes.includes(e.eventType) || e.severity === 'CRITICAL' || e.severity === 'EMERGENCY');

    const byType: Record<string, number> = {};
    const uniqueIps = new Set<string>();
    let criticalCount = 0;
    let failedAuthCount = 0;
    const recentActivity: Array<{ eventType: string; ip: string | null; createdAt: Date }> = [];

    for (const e of securityEvents) {
      byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
      if (e.ip) uniqueIps.add(e.ip);
      if (e.severity === 'CRITICAL' || e.severity === 'EMERGENCY') criticalCount++;
      if (e.eventType === 'auth.failed') failedAuthCount++;
      recentActivity.push({ eventType: e.eventType, ip: e.ip, createdAt: e.createdAt });
    }

    recentActivity.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const riskLevel = criticalCount > 0 ? 'high' : failedAuthCount > 5 ? 'medium' : 'low';

    return {
      totalSecurityEvents: securityEvents.length,
      byType,
      uniqueIps: uniqueIps.size,
      criticalCount,
      failedAuthAttempts: failedAuthCount,
      riskLevel,
      recentActivity: recentActivity.slice(0, 20),
    };
  }

  async getComplianceReport(userId: string) {
    const events = await this.prisma.event.findMany({ where: { userId } });

    const sensitiveTypes = ['auth.login', 'auth.failed', 'auth.password_changed', 'auth.mfa_enabled',
      'auth.mfa_disabled', 'auth.pin_set', 'session.created', 'session.revoked',
      'wallet.created', 'transfer.sent', 'transfer.received', 'fx.executed',
      'kyc.submitted', 'kyc.approved', 'kyc.rejected', 'card.added', 'card.removed',
      'bank_account.added', 'bank_account.removed', 'beneficiary.created', 'beneficiary.deleted'];

    const byCategory: Record<string, number> = {};
    const retentionBuckets: Record<string, number> = { '0-30d': 0, '31-90d': 0, '91-180d': 0, '181-365d': 0, '365d+': 0 };
    const now = Date.now();
    let sensitiveCount = 0;
    let oldestEvent: Date | null = null;
    let newestEvent: Date | null = null;

    for (const e of events) {
      const category = e.eventType.split('.')[0] ?? 'other';
      byCategory[category] = (byCategory[category] ?? 0) + 1;

      if (sensitiveTypes.includes(e.eventType)) sensitiveCount++;

      const ageMs = now - new Date(e.createdAt).getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      if (ageDays <= 30) retentionBuckets['0-30d']++;
      else if (ageDays <= 90) retentionBuckets['31-90d']++;
      else if (ageDays <= 180) retentionBuckets['91-180d']++;
      else if (ageDays <= 365) retentionBuckets['181-365d']++;
      else retentionBuckets['365d+']++;

      const created = new Date(e.createdAt);
      if (!oldestEvent || created < oldestEvent) oldestEvent = created;
      if (!newestEvent || created > newestEvent) newestEvent = created;
    }

    const recommendations: string[] = [];
    if (retentionBuckets['365d+'] > 0) recommendations.push(`${retentionBuckets['365d+']} events older than 1 year — review data retention policy`);
    if (sensitiveCount === 0 && events.length > 0) recommendations.push('No sensitive events logged — verify audit trail coverage');

    return {
      totalEvents: events.length,
      sensitiveEventCount: sensitiveCount,
      byCategory,
      retentionBuckets,
      oldestEvent,
      newestEvent,
      dataRetentionDays: oldestEvent ? Math.round((now - oldestEvent.getTime()) / (24 * 60 * 60 * 1000)) : 0,
      recommendations,
    };
  }

  async getEventVelocity(userId: string) {
    const events = await this.prisma.event.findMany({ where: { userId } });

    if (events.length === 0) {
      return {
        totalEvents: 0,
        eventsPerDay: 0,
        eventsPerHour: 0,
        peakDay: null as { date: string; count: number } | null,
        peakHour: null as { hour: number; count: number } | null,
        byDayOfWeek: {} as Record<string, number>,
        trend: 'none' as string,
      };
    }

    const now = new Date();
    const sorted = [...events].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const oldest = new Date(sorted[0]!.createdAt);
    const spanDays = Math.max(1, (now.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000));

    const eventsPerDay = Math.round((events.length / spanDays) * 100) / 100;
    const eventsPerHour = Math.round((events.length / (spanDays * 24)) * 100) / 100;

    const dayCountMap = new Map<string, number>();
    const hourCountMap = new Map<number, number>();
    const dayOfWeekNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const byDayOfWeek: Record<string, number> = {};

    for (const e of events) {
      const d = new Date(e.createdAt);
      const dateKey = d.toISOString().slice(0, 10);
      dayCountMap.set(dateKey, (dayCountMap.get(dateKey) ?? 0) + 1);

      const hour = d.getHours();
      hourCountMap.set(hour, (hourCountMap.get(hour) ?? 0) + 1);

      const dayName = dayOfWeekNames[d.getDay()]!;
      byDayOfWeek[dayName] = (byDayOfWeek[dayName] ?? 0) + 1;
    }

    let peakDay: { date: string; count: number } | null = null;
    for (const [date, count] of dayCountMap) {
      if (!peakDay || count > peakDay.count) peakDay = { date, count };
    }

    let peakHour: { hour: number; count: number } | null = null;
    for (const [hour, count] of hourCountMap) {
      if (!peakHour || count > peakHour.count) peakHour = { hour, count };
    }

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const recentCount = events.filter((e: any) => new Date(e.createdAt) >= sevenDaysAgo).length;
    const priorCount = events.filter((e: any) => {
      const d = new Date(e.createdAt);
      return d >= fourteenDaysAgo && d < sevenDaysAgo;
    }).length;

    let trend: string;
    if (recentCount > priorCount * 1.2) trend = 'increasing';
    else if (recentCount < priorCount * 0.8) trend = 'decreasing';
    else trend = 'stable';

    return {
      totalEvents: events.length,
      eventsPerDay,
      eventsPerHour,
      peakDay,
      peakHour,
      byDayOfWeek,
      trend,
    };
  }

  async listByRequest(requestId: string) {
    return this.prisma.event.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
