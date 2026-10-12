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

  async listByRequest(requestId: string) {
    return this.prisma.event.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
