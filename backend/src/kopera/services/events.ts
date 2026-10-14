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

  async getAnomalyDetection(userId: string) {
    const events = await this.prisma.event.findMany({ where: { userId } });

    if (events.length === 0) {
      return {
        totalEvents: 0,
        anomalies: [] as Array<{ type: string; detail: string; severity: string }>,
        riskLevel: 'none' as const,
        offHoursPercent: 0,
        rareEventTypes: [] as string[],
      };
    }

    const byType: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let offHoursCount = 0;

    for (const e of events) {
      byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
      const d = e.createdAt;
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      byDay[dayKey] = (byDay[dayKey] ?? 0) + 1;
      const hour = d.getHours();
      if (hour < 6 || hour >= 23) offHoursCount++;
    }

    const offHoursPercent = Math.round((offHoursCount / events.length) * 10000) / 100;

    const dayCounts = Object.values(byDay);
    const avgPerDay = dayCounts.reduce((s, c) => s + c, 0) / (dayCounts.length || 1);
    const stdDev = Math.sqrt(dayCounts.reduce((s, c) => s + (c - avgPerDay) ** 2, 0) / (dayCounts.length || 1));

    const anomalies: Array<{ type: string; detail: string; severity: string }> = [];

    const spikeDays = Object.entries(byDay).filter(([, c]) => c > avgPerDay + 2 * stdDev);
    for (const [day, count] of spikeDays) {
      anomalies.push({ type: 'activity_spike', detail: `${count} events on ${day} (avg ${Math.round(avgPerDay)})`, severity: 'medium' });
    }

    const rareEventTypes: string[] = [];
    for (const [type, count] of Object.entries(byType)) {
      if (count === 1) {
        rareEventTypes.push(type);
        anomalies.push({ type: 'rare_event', detail: `Event type "${type}" occurred only once`, severity: 'low' });
      }
    }

    if (offHoursPercent > 30) {
      anomalies.push({ type: 'off_hours_activity', detail: `${offHoursPercent}% of events occurred outside business hours`, severity: 'medium' });
    }

    const riskLevel = anomalies.filter(a => a.severity === 'medium').length >= 2 ? 'high'
      : anomalies.length > 0 ? 'medium' : 'low';

    return {
      totalEvents: events.length,
      anomalies,
      riskLevel,
      offHoursPercent,
      rareEventTypes,
    };
  }

  async listByRequest(requestId: string) {
    return this.prisma.event.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getCorrelationAnalysis(userId: string) {
    const events = await this.prisma.event.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (events.length < 2) {
      return {
        totalEvents: events.length,
        correlatedPairs: [],
        topPattern: null,
      };
    }

    const windowMs = 5 * 60 * 1000;
    const pairMap = new Map<string, { count: number; totalGapMs: number }>();

    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i];
      for (let j = i + 1; j < events.length; j++) {
        const b = events[j];
        const gap = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (gap > windowMs) break;
        if (a.eventType === b.eventType) continue;

        const key = `${a.eventType} -> ${b.eventType}`;
        const entry = pairMap.get(key) ?? { count: 0, totalGapMs: 0 };
        entry.count++;
        entry.totalGapMs += gap;
        pairMap.set(key, entry);
      }
    }

    const correlatedPairs = Array.from(pairMap.entries())
      .filter(([, v]) => v.count >= 2)
      .map(([pair, data]) => ({
        pair,
        occurrences: data.count,
        avgGapSeconds: Math.round(data.totalGapMs / data.count / 1000),
      }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10);

    return {
      totalEvents: events.length,
      correlatedPairs,
      topPattern: correlatedPairs.length > 0 ? correlatedPairs[0] : null,
    };
  }

  async getEventHeatmap(userId: string) {
    const events = await this.prisma.event.findMany({ where: { userId } });

    if (events.length === 0) {
      return {
        totalEvents: 0,
        byDayOfWeek: [],
        byHour: [],
        peakDay: null,
        peakHour: null,
        quietestDay: null,
        quietestHour: null,
        weekdayVsWeekend: { weekday: 0, weekend: 0, weekdayPercent: 0 },
      };
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayCounts = new Array(7).fill(0);
    const hourCounts = new Array(24).fill(0);

    for (const e of events) {
      const d = new Date(e.createdAt);
      dayCounts[d.getUTCDay()]++;
      hourCounts[d.getUTCHours()]++;
    }

    const byDayOfWeek = dayNames.map((name, i) => ({
      day: name,
      dayIndex: i,
      count: dayCounts[i],
      percent: Math.round((dayCounts[i] / events.length) * 10000) / 100,
    }));

    const byHour = hourCounts.map((count: number, h: number) => ({
      hour: h,
      count,
      percent: Math.round((count / events.length) * 10000) / 100,
    }));

    const peakDayIdx = dayCounts.indexOf(Math.max(...dayCounts));
    const quietDayIdx = dayCounts.indexOf(Math.min(...dayCounts));
    const peakHourIdx = hourCounts.indexOf(Math.max(...hourCounts));
    const quietHourIdx = hourCounts.indexOf(Math.min(...hourCounts));

    const weekday = dayCounts.slice(1, 6).reduce((s: number, c: number) => s + c, 0);
    const weekend = dayCounts[0] + dayCounts[6];

    return {
      totalEvents: events.length,
      byDayOfWeek,
      byHour,
      peakDay: dayNames[peakDayIdx],
      peakHour: peakHourIdx,
      quietestDay: dayNames[quietDayIdx],
      quietestHour: quietHourIdx,
      weekdayVsWeekend: {
        weekday,
        weekend,
        weekdayPercent: Math.round((weekday / events.length) * 10000) / 100,
      },
    };
  }

  async getEventCorrelationAnalysis(userId: string) {
    const events = await this.prisma.event.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (events.length < 2) {
      return {
        totalEvents: events.length,
        correlations: [],
        topSequence: null,
        avgTimeBetweenEvents: null,
      };
    }

    const gaps: number[] = [];
    const sequences = new Map<string, { count: number; avgGapMs: number; gaps: number[] }>();

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      const gapMs = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
      gaps.push(gapMs);

      const key = `${(prev as any).eventType}->${(curr as any).eventType}`;
      if (!sequences.has(key)) sequences.set(key, { count: 0, avgGapMs: 0, gaps: [] });
      const entry = sequences.get(key)!;
      entry.count++;
      entry.gaps.push(gapMs);
    }

    for (const entry of sequences.values()) {
      entry.avgGapMs = entry.gaps.reduce((s, g) => s + g, 0) / entry.gaps.length;
    }

    const correlations = Array.from(sequences.entries())
      .filter(([, data]) => data.count >= 2)
      .map(([sequence, data]) => ({
        sequence,
        occurrences: data.count,
        avgGapSeconds: Math.round(data.avgGapMs / 1000),
      }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10);

    const avgTotalGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;

    const topSequence = correlations.length > 0 ? correlations[0].sequence : null;

    return {
      totalEvents: events.length,
      correlations,
      topSequence,
      avgTimeBetweenEvents: Math.round(avgTotalGap / 1000),
    };
  }

  async getEventRetentionAnalysis(userId: string) {
    const events = await this.prisma.event.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (events.length === 0) {
      return {
        totalEvents: 0,
        activeDays: 0,
        inactiveDays: 0,
        longestStreak: 0,
        currentStreak: 0,
        retentionRate: 0,
      };
    }

    const daySet = new Set<string>();
    for (const e of events) {
      const d = new Date(e.createdAt);
      daySet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }

    const firstDay = new Date(events[0].createdAt).getTime();
    const now = Date.now();
    const totalDays = Math.max(1, Math.ceil((now - firstDay) / 86400000));
    const activeDays = daySet.size;
    const inactiveDays = totalDays - activeDays;

    const sortedDays = Array.from(daySet).map(d => {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(y, m, day).getTime();
    }).sort((a, b) => a - b);

    let longestStreak = 1;
    let currentStreak = 1;
    let streak = 1;
    for (let i = 1; i < sortedDays.length; i++) {
      const diff = (sortedDays[i] - sortedDays[i - 1]) / 86400000;
      if (diff <= 1) {
        streak++;
        if (streak > longestStreak) longestStreak = streak;
      } else {
        streak = 1;
      }
    }

    const lastActiveDay = sortedDays[sortedDays.length - 1];
    const daysSinceLastActive = Math.ceil((now - lastActiveDay) / 86400000);
    currentStreak = daysSinceLastActive <= 1 ? streak : 0;

    const retentionRate = Math.round((activeDays / totalDays) * 10000) / 100;

    return {
      totalEvents: events.length,
      activeDays,
      inactiveDays,
      longestStreak,
      currentStreak,
      retentionRate,
    };
  }

  async getEventBurstDetection(userId: string) {
    const events = await this.prisma.event.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    if (events.length === 0) {
      return {
        totalEvents: 0,
        anomalies: [],
        anomalyCount: 0,
        anomalyRate: 0,
        riskLevel: 'none',
      };
    }

    const byDay: Record<string, number> = {};
    for (const e of events) {
      const d = new Date(e.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      byDay[key] = (byDay[key] || 0) + 1;
    }

    const counts = Object.values(byDay);
    const mean = counts.reduce((s, c) => s + c, 0) / counts.length;
    const variance = counts.reduce((s, c) => s + Math.pow(c - mean, 2), 0) / counts.length;
    const stdDev = Math.sqrt(variance);
    const threshold = mean + 2 * stdDev;

    const anomalies: { date: string; count: number; deviation: number }[] = [];
    for (const [date, count] of Object.entries(byDay)) {
      if (count > threshold && stdDev > 0) {
        const deviation = Math.round(((count - mean) / stdDev) * 100) / 100;
        anomalies.push({ date, count, deviation });
      }
    }

    anomalies.sort((a, b) => b.deviation - a.deviation);

    const anomalyRate = Math.round((anomalies.length / Object.keys(byDay).length) * 10000) / 100;
    const riskLevel = anomalies.length >= 5 ? 'high' : anomalies.length >= 2 ? 'medium' : anomalies.length >= 1 ? 'low' : 'none';

    return {
      totalEvents: events.length,
      anomalies: anomalies.slice(0, 10),
      anomalyCount: anomalies.length,
      anomalyRate,
      riskLevel,
    };
  }

  async getEventRetentionCompliance(userId: string) {
    const events = await this.prisma.event.findMany({ where: { userId } });

    if (events.length === 0) {
      return {
        totalEvents: 0,
        complianceLevel: 'no_data' as const,
        retentionScore: 0,
        categories: [],
        oldestEventDays: 0,
        recommendations: [],
      };
    }

    const now = Date.now();
    const categoryMap = new Map<string, { count: number; oldestDays: number; newestDays: number }>();

    let oldestDays = 0;

    for (const e of events) {
      const ageDays = Math.floor((now - new Date(e.createdAt).getTime()) / 86400000);
      if (ageDays > oldestDays) oldestDays = ageDays;

      const cat = (e as any).eventType || (e as any).type || 'unknown';
      const existing = categoryMap.get(cat);
      if (existing) {
        existing.count++;
        if (ageDays > existing.oldestDays) existing.oldestDays = ageDays;
        if (ageDays < existing.newestDays) existing.newestDays = ageDays;
      } else {
        categoryMap.set(cat, { count: 1, oldestDays: ageDays, newestDays: ageDays });
      }
    }

    const categories = Array.from(categoryMap.entries())
      .map(([name, data]) => ({
        name,
        count: data.count,
        oldestDays: data.oldestDays,
        newestDays: data.newestDays,
        retentionSpanDays: data.oldestDays - data.newestDays,
      }))
      .sort((a, b) => b.count - a.count);

    const recommendations: string[] = [];
    if (oldestDays > 365) recommendations.push('Consider archiving events older than 1 year');
    if (oldestDays > 730) recommendations.push('Events older than 2 years may violate retention policies');
    if (categories.length > 20) recommendations.push('High event type diversity — consider consolidation');

    let retentionScore = 100;
    if (oldestDays > 730) retentionScore -= 30;
    else if (oldestDays > 365) retentionScore -= 15;
    if (events.length > 10000) retentionScore -= 20;
    if (categories.some(c => c.count === 1)) retentionScore -= 10;
    retentionScore = Math.max(0, retentionScore);

    const complianceLevel = retentionScore >= 70 ? 'compliant' : retentionScore >= 40 ? 'at_risk' : 'non_compliant';

    return {
      totalEvents: events.length,
      complianceLevel,
      retentionScore,
      categories: categories.slice(0, 10),
      oldestEventDays: oldestDays,
      recommendations,
    };
  }
}
