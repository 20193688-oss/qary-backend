import type { PrismaClient } from '@prisma/client';

export class UserSessionService {
  constructor(private prisma: PrismaClient) {}

  async createSession(userId: string, data: {
    deviceId: string;
    deviceName?: string;
    ip: string;
    userAgent?: string;
    expiresAt: Date;
  }) {
    return this.prisma.userSession.create({
      data: { userId, ...data },
    });
  }

  async listActive(userId: string) {
    return this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastActiveAt: 'desc' },
    });
  }

  async getSession(id: string, userId: string) {
    const session = await this.prisma.userSession.findUnique({ where: { id } });
    if (!session) return null;
    if (session.userId !== userId) return null;
    return session;
  }

  async revoke(id: string, userId: string) {
    const session = await this.prisma.userSession.findUnique({ where: { id } });
    if (!session) throw new Error('session_not_found');
    if (session.userId !== userId) throw new Error('forbidden');
    if (session.revokedAt) throw new Error('already_revoked');

    return this.prisma.userSession.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllOther(userId: string, currentSessionId: string) {
    return this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null, id: { not: currentSessionId } },
      data: { revokedAt: new Date() },
    });
  }

  async touch(id: string) {
    return this.prisma.userSession.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    });
  }

  async listAll(userId: string, opts?: { limit?: number; offset?: number }) {
    return this.prisma.userSession.findMany({
      where: { userId },
      take: Math.min(opts?.limit ?? 20, 100),
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSecurityOverview(userId: string) {
    const all = await this.prisma.userSession.findMany({ where: { userId } });
    let activeCount = 0;
    let revokedCount = 0;
    let expiredCount = 0;
    const uniqueIps = new Set<string>();
    const uniqueDevices = new Set<string>();
    const now = new Date();

    for (const s of all) {
      if (s.revokedAt) revokedCount++;
      else if (s.expiresAt && s.expiresAt <= now) expiredCount++;
      else activeCount++;
      if (s.ip) uniqueIps.add(s.ip);
      if (s.deviceId) uniqueDevices.add(s.deviceId);
    }

    return {
      totalSessions: all.length,
      activeSessions: activeCount,
      revokedSessions: revokedCount,
      expiredSessions: expiredCount,
      uniqueIps: uniqueIps.size,
      uniqueDevices: uniqueDevices.size,
    };
  }

  async getDeviceReport(userId: string) {
    const all = await this.prisma.userSession.findMany({ where: { userId } });
    const byDevice: Record<string, { deviceName: string | null; sessionCount: number; ips: Set<string>; lastSeen: Date | null }> = {};

    for (const s of all) {
      if (!byDevice[s.deviceId]) {
        byDevice[s.deviceId] = { deviceName: (s as any).deviceName ?? null, sessionCount: 0, ips: new Set(), lastSeen: null };
      }
      const entry = byDevice[s.deviceId];
      entry.sessionCount++;
      if (s.ip) entry.ips.add(s.ip);
      const activity = s.lastActiveAt ?? s.createdAt;
      if (!entry.lastSeen || activity > entry.lastSeen) entry.lastSeen = activity;
    }

    const devices = Object.entries(byDevice).map(([deviceId, data]) => ({
      deviceId,
      deviceName: data.deviceName,
      sessionCount: data.sessionCount,
      uniqueIps: data.ips.size,
      lastSeen: data.lastSeen,
      suspicious: data.ips.size > 10,
    }));

    const suspiciousCount = devices.filter((d) => d.suspicious).length;

    return {
      totalDevices: devices.length,
      totalSessions: all.length,
      suspiciousDevices: suspiciousCount,
      devices,
    };
  }

  async getRiskAssessment(userId: string) {
    const all = await this.prisma.userSession.findMany({ where: { userId } });
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const recentSessions = all.filter((s: any) => new Date(s.createdAt) >= sevenDaysAgo);
    const uniqueIps = new Set<string>();
    const uniqueDevices = new Set<string>();
    const recentIps = new Set<string>();
    const ipByDevice: Record<string, Set<string>> = {};

    for (const s of all) {
      if (s.ip) uniqueIps.add(s.ip);
      if (s.deviceId) uniqueDevices.add(s.deviceId);
    }

    for (const s of recentSessions) {
      if (s.ip) recentIps.add(s.ip);
      if (s.deviceId) {
        if (!ipByDevice[s.deviceId]) ipByDevice[s.deviceId] = new Set();
        if (s.ip) ipByDevice[s.deviceId].add(s.ip);
      }
    }

    const activeSessions = all.filter((s: any) => !s.revokedAt && (!s.expiresAt || s.expiresAt > now)).length;

    const riskFactors: string[] = [];
    let riskScore = 0;

    if (recentIps.size > 5) {
      riskFactors.push(`${recentIps.size} different IPs in last 7 days`);
      riskScore += 20;
    }
    if (recentSessions.length > 10) {
      riskFactors.push(`${recentSessions.length} sessions created in last 7 days`);
      riskScore += 15;
    }
    if (activeSessions > 5) {
      riskFactors.push(`${activeSessions} concurrent active sessions`);
      riskScore += 15;
    }

    for (const [deviceId, ips] of Object.entries(ipByDevice)) {
      if (ips.size > 3) {
        riskFactors.push(`Device ${deviceId.slice(0, 8)}... used from ${ips.size} IPs recently`);
        riskScore += 10;
      }
    }

    riskScore = Math.min(riskScore, 100);
    let riskLevel: string;
    if (riskScore >= 60) riskLevel = 'high';
    else if (riskScore >= 30) riskLevel = 'medium';
    else riskLevel = 'low';

    const recommendations: string[] = [];
    if (activeSessions > 3) recommendations.push('Review and revoke unused sessions');
    if (riskScore >= 30) recommendations.push('Enable MFA if not already active');
    if (recentIps.size > 3) recommendations.push('Verify all login locations are recognized');

    return {
      riskScore,
      riskLevel,
      activeSessions,
      totalSessions: all.length,
      uniqueIps: uniqueIps.size,
      uniqueDevices: uniqueDevices.size,
      recentSessionCount: recentSessions.length,
      recentUniqueIps: recentIps.size,
      riskFactors,
      recommendations,
    };
  }

  async getGeoDistribution(userId: string) {
    const all = await this.prisma.userSession.findMany({ where: { userId } });

    if (all.length === 0) {
      return {
        totalSessions: 0,
        uniqueLocations: 0,
        primaryIp: null,
        concentrationPercent: 0,
        byIp: [],
      };
    }

    const ipCounts: Record<string, { count: number; lastSeen: Date | null; devices: Set<string> }> = {};

    for (const s of all) {
      const ip = s.ip ?? 'unknown';
      if (!ipCounts[ip]) {
        ipCounts[ip] = { count: 0, lastSeen: null, devices: new Set() };
      }
      ipCounts[ip].count++;
      const activity = s.lastActiveAt ?? s.createdAt;
      if (!ipCounts[ip].lastSeen || activity > ipCounts[ip].lastSeen!) {
        ipCounts[ip].lastSeen = activity;
      }
      if (s.deviceId) ipCounts[ip].devices.add(s.deviceId);
    }

    const byIp = Object.entries(ipCounts)
      .map(([ip, data]) => ({
        ip,
        sessionCount: data.count,
        sharePercent: Math.round(data.count / all.length * 10000) / 100,
        deviceCount: data.devices.size,
        lastSeen: data.lastSeen,
      }))
      .sort((a, b) => b.sessionCount - a.sessionCount);

    const primaryIp = byIp[0]?.ip ?? null;
    const concentrationPercent = byIp[0]?.sharePercent ?? 0;

    return {
      totalSessions: all.length,
      uniqueLocations: byIp.length,
      primaryIp,
      concentrationPercent,
      byIp,
    };
  }

  async getSessionLifecycle(userId: string) {
    const all = await this.prisma.userSession.findMany({ where: { userId } });
    const now = new Date();

    let activeCount = 0;
    let revokedCount = 0;
    let expiredCount = 0;
    const durations: number[] = [];

    for (const s of all) {
      let endTime: Date;
      if (s.revokedAt) {
        revokedCount++;
        endTime = s.revokedAt;
      } else if (s.expiresAt && s.expiresAt <= now) {
        expiredCount++;
        endTime = s.expiresAt;
      } else {
        activeCount++;
        endTime = now;
      }

      const durationHours = Math.round((endTime.getTime() - new Date(s.createdAt).getTime()) / (1000 * 60 * 60) * 10) / 10;
      durations.push(durationHours);
    }

    const avgDurationHours = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length * 10) / 10
      : 0;

    const longestDurationHours = durations.length > 0 ? Math.max(...durations) : 0;
    const shortestDurationHours = durations.length > 0 ? Math.min(...durations) : 0;

    const manualRevocationRate = all.length > 0
      ? Math.round(revokedCount / all.length * 10000) / 100
      : 0;

    return {
      totalSessions: all.length,
      activeCount,
      revokedCount,
      expiredCount,
      avgDurationHours,
      longestDurationHours,
      shortestDurationHours,
      manualRevocationRate,
    };
  }

  async cleanupExpired() {
    const now = new Date();
    const expired = await this.prisma.userSession.findMany({
      where: { revokedAt: null, expiresAt: { lte: now } },
    });

    for (const session of expired) {
      await this.prisma.userSession.update({
        where: { id: session.id },
        data: { revokedAt: now },
      });
    }

    return { cleaned: expired.length };
  }

  async getLoginFrequency(userId: string) {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        byDayOfWeek: [],
        byHourOfDay: [],
        peakDay: null,
        peakHour: null,
        avgSessionsPerWeek: 0,
        recentVsPrior: { last7Days: 0, prior7Days: 0, trend: 'stable' as string },
      };
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayCounts = new Array(7).fill(0);
    const hourCounts = new Array(24).fill(0);

    for (const s of sessions) {
      const d = new Date(s.createdAt);
      dayCounts[d.getDay()]++;
      hourCounts[d.getHours()]++;
    }

    const byDayOfWeek = dayNames.map((name, i) => ({ day: name, count: dayCounts[i] }));
    const byHourOfDay = hourCounts.map((count: number, hour: number) => ({ hour, count }));

    const peakDayIdx = dayCounts.indexOf(Math.max(...dayCounts));
    const peakHourIdx = hourCounts.indexOf(Math.max(...hourCounts));

    const now = Date.now();
    const d7 = now - 7 * 24 * 60 * 60 * 1000;
    const d14 = now - 14 * 24 * 60 * 60 * 1000;
    const last7 = sessions.filter((s: any) => new Date(s.createdAt).getTime() >= d7).length;
    const prior7 = sessions.filter((s: any) => {
      const t = new Date(s.createdAt).getTime();
      return t >= d14 && t < d7;
    }).length;

    const oldest = new Date(sessions[sessions.length - 1].createdAt).getTime();
    const weeksSpan = Math.max(1, (now - oldest) / (7 * 24 * 60 * 60 * 1000));
    const avgPerWeek = Math.round((sessions.length / weeksSpan) * 100) / 100;

    let trend = 'stable';
    if (prior7 > 0) {
      const change = (last7 - prior7) / prior7;
      if (change > 0.2) trend = 'increasing';
      else if (change < -0.2) trend = 'decreasing';
    } else if (last7 > 0) {
      trend = 'increasing';
    }

    return {
      totalSessions: sessions.length,
      byDayOfWeek,
      byHourOfDay,
      peakDay: dayNames[peakDayIdx],
      peakHour: peakHourIdx,
      avgSessionsPerWeek: avgPerWeek,
      recentVsPrior: { last7Days: last7, prior7Days: prior7, trend },
    };
  }
}
