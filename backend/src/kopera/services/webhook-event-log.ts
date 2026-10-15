import type { PrismaClient } from '@prisma/client';

export class WebhookEventLogService {
  constructor(private prisma: PrismaClient) {}

  async createLog(userId: string, data: {
    webhookConfigId: string;
    eventType: string;
    payload: string;
    targetUrl: string;
  }) {
    return this.prisma.webhookEventLog.create({
      data: {
        userId,
        webhookConfigId: data.webhookConfigId,
        eventType: data.eventType.toUpperCase(),
        payload: data.payload,
        targetUrl: data.targetUrl,
        status: 'PENDING',
        attempts: 0,
        lastAttemptAt: null,
        responseCode: null,
        responseBody: null,
      },
    });
  }

  async getLogs(userId: string) {
    return this.prisma.webhookEventLog.findMany({ where: { userId } });
  }

  async getLog(userId: string, id: string) {
    const l = await this.prisma.webhookEventLog.findFirst({ where: { id, userId } });
    if (!l) throw new Error('log_not_found');
    return l;
  }

  async recordAttempt(userId: string, id: string, data: {
    responseCode: number;
    responseBody: string;
  }) {
    const l = await this.prisma.webhookEventLog.findFirst({ where: { id, userId } });
    if (!l) throw new Error('log_not_found');
    const newStatus = data.responseCode >= 200 && data.responseCode < 300 ? 'DELIVERED' : 'FAILED';
    return this.prisma.webhookEventLog.update({
      where: { id },
      data: {
        status: newStatus,
        attempts: l.attempts + 1,
        lastAttemptAt: new Date(),
        responseCode: data.responseCode,
        responseBody: data.responseBody,
      },
    });
  }

  async retryLog(userId: string, id: string) {
    const l = await this.prisma.webhookEventLog.findFirst({ where: { id, userId } });
    if (!l) throw new Error('log_not_found');
    if (l.status !== 'FAILED') throw new Error('log_not_failed');
    return this.prisma.webhookEventLog.update({
      where: { id },
      data: { status: 'PENDING' },
    });
  }

  async getLogAnalytics(userId: string) {
    const all = await this.prisma.webhookEventLog.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalLogs: 0, analyticsLevel: 'no_data' as const };
    }
    const byStatus: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    let totalAttempts = 0;
    for (const l of all) {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      byEventType[l.eventType] = (byEventType[l.eventType] || 0) + 1;
      totalAttempts += l.attempts;
    }
    return {
      totalLogs: all.length,
      byStatus,
      byEventType,
      totalAttempts,
      analyticsLevel: 'full' as const,
    };
  }
}
