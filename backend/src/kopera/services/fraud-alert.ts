import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class FraudAlertService {
  constructor(private prisma: PrismaClient) {}

  async createAlert(userId: string, data: {
    transactionId?: string;
    alertType: string;
    severity: string;
    description: string;
    latitude?: number;
    longitude?: number;
    ipAddress?: string;
    deviceId?: string;
  }) {
    return this.prisma.fraudAlert.create({
      data: {
        userId,
        transactionId: data.transactionId || null,
        alertType: data.alertType,
        severity: data.severity,
        description: data.description,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        ipAddress: data.ipAddress || null,
        deviceId: data.deviceId || null,
        status: 'OPEN',
        reference: `FRD-${Date.now()}-${randomUUID().slice(0, 8)}`,
        detectedAt: new Date(),
      },
    });
  }

  async getAlerts(userId: string) {
    return this.prisma.fraudAlert.findMany({ where: { userId } });
  }

  async getAlert(userId: string, id: string) {
    const alert = await this.prisma.fraudAlert.findUnique({ where: { id } });
    if (!alert) throw new Error('alert_not_found');
    if ((alert as any).userId !== userId) throw new Error('alert_not_found');
    return alert;
  }

  async resolveAlert(userId: string, id: string, resolution: string) {
    const alert = await this.getAlert(userId, id);
    if ((alert as any).status === 'RESOLVED') throw new Error('alert_already_resolved');
    return this.prisma.fraudAlert.update({
      where: { id },
      data: { status: 'RESOLVED', resolution, resolvedAt: new Date() },
    });
  }

  async escalateAlert(userId: string, id: string) {
    const alert = await this.getAlert(userId, id);
    if ((alert as any).status === 'RESOLVED') throw new Error('alert_already_resolved');
    return this.prisma.fraudAlert.update({
      where: { id },
      data: { status: 'ESCALATED', severity: 'CRITICAL' },
    });
  }

  async autoBlockCheck(userId: string, transactionId: string, data: {
    amount: bigint;
    latitude?: number;
    longitude?: number;
    ipAddress?: string;
  }) {
    const recentAlerts = await this.prisma.fraudAlert.findMany({
      where: { userId, status: { not: 'RESOLVED' } },
    });

    const riskFactors: string[] = [];
    let riskScore = 0;

    if (recentAlerts.length >= 3) {
      riskFactors.push('multiple_open_alerts');
      riskScore += 30;
    }

    const criticalAlerts = recentAlerts.filter((a: any) => a.severity === 'CRITICAL');
    if (criticalAlerts.length > 0) {
      riskFactors.push('critical_alerts_active');
      riskScore += 40;
    }

    if (Number(data.amount) > 1000000) {
      riskFactors.push('high_value_transaction');
      riskScore += 20;
    }

    const shouldBlock = riskScore >= 50;

    if (shouldBlock) {
      await this.createAlert(userId, {
        transactionId,
        alertType: 'AUTO_BLOCK',
        severity: 'HIGH',
        description: `Auto-blocked: ${riskFactors.join(', ')}`,
        latitude: data.latitude,
        longitude: data.longitude,
        ipAddress: data.ipAddress,
      });
    }

    return {
      shouldBlock,
      riskScore,
      riskFactors,
      recommendation: shouldBlock ? 'BLOCK' : 'ALLOW',
    };
  }

  async getFraudAnalytics(userId: string) {
    const alerts = await this.prisma.fraudAlert.findMany({ where: { userId } });

    if (alerts.length === 0) {
      return {
        totalAlerts: 0,
        breakdown: { open: 0, escalated: 0, resolved: 0 },
        bySeverity: {},
        byType: {},
        resolutionRate: 0,
        analyticsLevel: 'no_data',
      };
    }

    const breakdown = { open: 0, escalated: 0, resolved: 0 };
    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const a of alerts as any[]) {
      const status = a.status.toLowerCase() as keyof typeof breakdown;
      if (status in breakdown) breakdown[status]++;
      bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
      byType[a.alertType] = (byType[a.alertType] || 0) + 1;
    }

    const resolutionRate = alerts.length > 0
      ? Math.round((breakdown.resolved / alerts.length) * 100)
      : 0;

    let analyticsLevel: string;
    if (breakdown.open + breakdown.escalated === 0) analyticsLevel = 'secure';
    else if (breakdown.escalated > 0) analyticsLevel = 'critical';
    else analyticsLevel = 'attention_needed';

    return {
      totalAlerts: alerts.length,
      breakdown,
      bySeverity,
      byType,
      resolutionRate,
      analyticsLevel,
    };
  }
}
