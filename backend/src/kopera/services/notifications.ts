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

  async deleteAllRead(userId: string) {
    return this.prisma.notification.deleteMany({
      where: { userId, readAt: { not: null } },
    });
  }

  async delete(id: string, userId: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new Error('notification_not_found');
    if (n.userId !== userId) throw new Error('forbidden');

    return this.prisma.notification.delete({ where: { id } });
  }
}
