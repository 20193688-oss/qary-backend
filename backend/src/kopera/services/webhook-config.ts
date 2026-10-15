import type { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class WebhookConfigService {
  constructor(private prisma: PrismaClient) {}

  async createWebhook(userId: string, data: {
    url: string;
    events: string[];
    description?: string;
  }) {
    const existing = await this.prisma.webhookConfig.findMany({ where: { userId } });
    const activeCount = (existing as any[]).filter((w) => w.isActive).length;
    if (activeCount >= 10) throw new Error('max_webhooks_reached');

    const duplicate = (existing as any[]).find(
      (w) => w.url === data.url && w.isActive,
    );
    if (duplicate) throw new Error('webhook_url_exists');

    const secret = randomBytes(32).toString('hex');
    const secretHash = createHash('sha256').update(secret).digest('hex');

    const webhook = await this.prisma.webhookConfig.create({
      data: {
        userId,
        url: data.url,
        events: JSON.stringify(data.events),
        description: data.description || null,
        secretHash,
        isActive: true,
        reference: `WHK-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });

    return { ...(webhook as any), secret, secretHash: undefined };
  }

  async getWebhooks(userId: string) {
    const webhooks = await this.prisma.webhookConfig.findMany({ where: { userId } });
    return (webhooks as any[]).map((w) => ({
      ...w,
      events: typeof w.events === 'string' ? JSON.parse(w.events) : w.events,
      secretHash: undefined,
    }));
  }

  async getWebhook(userId: string, id: string) {
    const webhook = await this.prisma.webhookConfig.findUnique({ where: { id } });
    if (!webhook) throw new Error('webhook_not_found');
    if ((webhook as any).userId !== userId) throw new Error('webhook_not_found');
    return {
      ...(webhook as any),
      events: typeof (webhook as any).events === 'string'
        ? JSON.parse((webhook as any).events)
        : (webhook as any).events,
      secretHash: undefined,
    };
  }

  async updateWebhook(userId: string, id: string, data: {
    url?: string;
    events?: string[];
    description?: string;
  }) {
    await this.getWebhook(userId, id);

    const updateData: Record<string, unknown> = {};
    if (data.url) updateData.url = data.url;
    if (data.events) updateData.events = JSON.stringify(data.events);
    if (data.description !== undefined) updateData.description = data.description || null;

    const updated = await this.prisma.webhookConfig.update({
      where: { id },
      data: updateData,
    });

    return {
      ...(updated as any),
      events: typeof (updated as any).events === 'string'
        ? JSON.parse((updated as any).events)
        : (updated as any).events,
      secretHash: undefined,
    };
  }

  async deactivateWebhook(userId: string, id: string) {
    await this.getWebhook(userId, id);
    return this.prisma.webhookConfig.update({
      where: { id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  }

  async rotateSecret(userId: string, id: string) {
    await this.getWebhook(userId, id);
    const newSecret = randomBytes(32).toString('hex');
    const newHash = createHash('sha256').update(newSecret).digest('hex');

    const updated = await this.prisma.webhookConfig.update({
      where: { id },
      data: { secretHash: newHash },
    });

    return { ...(updated as any), secret: newSecret, secretHash: undefined };
  }

  async recordDelivery(userId: string, webhookId: string, data: {
    eventType: string;
    payload: string;
    statusCode: number;
    success: boolean;
    responseTime: number;
  }) {
    return this.prisma.webhookDelivery.create({
      data: {
        webhookId,
        userId,
        eventType: data.eventType,
        payload: data.payload,
        statusCode: data.statusCode,
        success: data.success,
        responseTimeMs: data.responseTime,
        deliveredAt: new Date(),
      },
    });
  }

  async getDeliveryLog(userId: string, webhookId: string) {
    await this.getWebhook(userId, webhookId);
    return this.prisma.webhookDelivery.findMany({ where: { webhookId, userId } });
  }

  async getWebhookAnalytics(userId: string) {
    const webhooks = await this.prisma.webhookConfig.findMany({ where: { userId } });
    const deliveries = await this.prisma.webhookDelivery.findMany({ where: { userId } });

    if (webhooks.length === 0) {
      return {
        totalWebhooks: 0,
        activeWebhooks: 0,
        totalDeliveries: 0,
        successRate: 0,
        avgResponseTime: 0,
        analyticsLevel: 'no_data',
      };
    }

    const active = (webhooks as any[]).filter((w) => w.isActive).length;
    const successCount = (deliveries as any[]).filter((d) => d.success).length;
    const successRate = deliveries.length > 0
      ? Math.round((successCount / deliveries.length) * 100)
      : 0;

    const totalResponseTime = (deliveries as any[]).reduce(
      (s: number, d: any) => s + (d.responseTimeMs || 0), 0,
    );
    const avgResponseTime = deliveries.length > 0
      ? Math.round(totalResponseTime / deliveries.length)
      : 0;

    let analyticsLevel: string;
    if (successRate >= 95) analyticsLevel = 'healthy';
    else if (successRate >= 80) analyticsLevel = 'degraded';
    else analyticsLevel = 'failing';

    return {
      totalWebhooks: webhooks.length,
      activeWebhooks: active,
      totalDeliveries: deliveries.length,
      successRate,
      avgResponseTime,
      analyticsLevel,
    };
  }
}
