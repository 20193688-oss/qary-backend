import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class BalanceAlertService {
  constructor(private prisma: PrismaClient) {}

  async createAlert(userId: string, data: {
    walletId: string;
    alertType: string;
    threshold: bigint;
    currency: string;
    channel?: string;
  }) {
    return this.prisma.balanceAlert.create({
      data: {
        userId,
        walletId: data.walletId,
        alertType: data.alertType.toUpperCase(),
        threshold: data.threshold,
        currency: data.currency.toUpperCase(),
        channel: data.channel || 'push',
        isActive: true,
        triggerCount: 0,
        reference: `BAL-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getAlerts(userId: string) {
    return this.prisma.balanceAlert.findMany({ where: { userId } });
  }

  async getAlert(userId: string, id: string) {
    const alert = await this.prisma.balanceAlert.findUnique({ where: { id } });
    if (!alert) throw new Error('alert_not_found');
    if ((alert as any).userId !== userId) throw new Error('alert_not_found');
    return alert;
  }

  async toggleAlert(userId: string, id: string, active: boolean) {
    await this.getAlert(userId, id);
    return this.prisma.balanceAlert.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async updateThreshold(userId: string, id: string, threshold: bigint) {
    await this.getAlert(userId, id);
    return this.prisma.balanceAlert.update({
      where: { id },
      data: { threshold },
    });
  }

  async recordTrigger(userId: string, id: string) {
    const alert = await this.getAlert(userId, id);
    return this.prisma.balanceAlert.update({
      where: { id },
      data: { triggerCount: ((alert as any).triggerCount || 0) + 1, lastTriggeredAt: new Date() },
    });
  }

  async deleteAlert(userId: string, id: string) {
    await this.getAlert(userId, id);
    return this.prisma.balanceAlert.delete({ where: { id } });
  }

  async getAlertAnalytics(userId: string) {
    const alerts = await this.prisma.balanceAlert.findMany({ where: { userId } });

    if (alerts.length === 0) {
      return {
        totalAlerts: 0,
        activeAlerts: 0,
        alertTypes: {},
        totalTriggers: 0,
        analyticsLevel: 'no_data',
      };
    }

    const active = (alerts as any[]).filter((a) => a.isActive).length;
    const alertTypes: Record<string, number> = {};
    let totalTriggers = 0;
    for (const a of alerts as any[]) {
      alertTypes[a.alertType] = (alertTypes[a.alertType] || 0) + 1;
      totalTriggers += a.triggerCount || 0;
    }

    return {
      totalAlerts: alerts.length,
      activeAlerts: active,
      alertTypes,
      totalTriggers,
      analyticsLevel: alerts.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
