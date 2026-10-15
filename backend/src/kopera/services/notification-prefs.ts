import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class NotificationPrefsService {
  constructor(private prisma: PrismaClient) {}

  async setPreference(userId: string, data: {
    eventType: string;
    channel: string;
    enabled: boolean;
  }) {
    const existing = await this.prisma.notificationPref.findFirst({
      where: { userId, eventType: data.eventType, channel: data.channel },
    });

    if (existing) {
      return this.prisma.notificationPref.update({
        where: { id: (existing as any).id },
        data: { enabled: data.enabled },
      });
    }

    return this.prisma.notificationPref.create({
      data: {
        userId,
        eventType: data.eventType,
        channel: data.channel,
        enabled: data.enabled,
        reference: `NPR-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getPreferences(userId: string) {
    return this.prisma.notificationPref.findMany({ where: { userId } });
  }

  async getPreferencesByEvent(userId: string, eventType: string) {
    const prefs = await this.prisma.notificationPref.findMany({ where: { userId } });
    return (prefs as any[]).filter((p) => p.eventType === eventType);
  }

  async bulkSet(userId: string, preferences: Array<{
    eventType: string;
    channel: string;
    enabled: boolean;
  }>) {
    const results = [];
    for (const pref of preferences) {
      const result = await this.setPreference(userId, pref);
      results.push(result);
    }
    return results;
  }

  async resetToDefaults(userId: string) {
    await this.prisma.notificationPref.deleteMany({ where: { userId } });
    const defaults = [
      { eventType: 'payment.completed', channel: 'push', enabled: true },
      { eventType: 'payment.completed', channel: 'email', enabled: true },
      { eventType: 'security.alert', channel: 'push', enabled: true },
      { eventType: 'security.alert', channel: 'email', enabled: true },
      { eventType: 'security.alert', channel: 'sms', enabled: true },
      { eventType: 'marketing', channel: 'email', enabled: false },
    ];
    return this.bulkSet(userId, defaults);
  }

  async getPreferenceAnalytics(userId: string) {
    const prefs = await this.prisma.notificationPref.findMany({ where: { userId } });

    if (prefs.length === 0) {
      return {
        totalPreferences: 0,
        enabledCount: 0,
        disabledCount: 0,
        channels: [],
        analyticsLevel: 'no_data',
      };
    }

    const enabled = (prefs as any[]).filter((p) => p.enabled).length;
    const disabled = prefs.length - enabled;
    const channels = [...new Set((prefs as any[]).map((p) => p.channel))];
    const channelBreakdown: Record<string, { enabled: number; disabled: number }> = {};

    for (const p of prefs as any[]) {
      if (!channelBreakdown[p.channel]) channelBreakdown[p.channel] = { enabled: 0, disabled: 0 };
      if (p.enabled) channelBreakdown[p.channel].enabled++;
      else channelBreakdown[p.channel].disabled++;
    }

    return {
      totalPreferences: prefs.length,
      enabledCount: enabled,
      disabledCount: disabled,
      channels,
      channelBreakdown,
      analyticsLevel: prefs.length >= 5 ? 'customized' : 'minimal',
    };
  }
}
