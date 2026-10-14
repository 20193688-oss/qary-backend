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

  async getSessionAnomalyDetection(userId: string) {
    const sessions = await this.prisma.userSession.findMany({ where: { userId } });
    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        anomalyCount: 0,
        anomalyRate: 0,
        riskLevel: 'none' as const,
        flaggedSessions: [],
      };
    }

    const ipCounts = new Map<string, number>();
    const deviceCounts = new Map<string, number>();
    const hourCounts = new Array(24).fill(0);

    for (const session of sessions) {
      const s = session as any;
      ipCounts.set(s.ip, (ipCounts.get(s.ip) || 0) + 1);
      if (s.deviceId) deviceCounts.set(s.deviceId, (deviceCounts.get(s.deviceId) || 0) + 1);
      const hour = new Date(s.createdAt).getUTCHours();
      hourCounts[hour]++;
    }

    const totalH = hourCounts.reduce((a, b) => a + b, 0);
    const avgPerHour = totalH / 24;

    const flaggedSessions: { sessionId: string; reasons: string[]; anomalyScore: number }[] = [];

    for (const session of sessions) {
      const s = session as any;
      const reasons: string[] = [];
      let score = 0;

      const ipCount = ipCounts.get(s.ip) || 0;
      if (ipCount === 1 && sessions.length > 3) {
        reasons.push('unique_ip');
        score += 30;
      }

      if (s.deviceId) {
        const devCount = deviceCounts.get(s.deviceId) || 0;
        if (devCount === 1 && sessions.length > 3) {
          reasons.push('new_device');
          score += 25;
        }
      }

      const hour = new Date(s.createdAt).getUTCHours();
      if (hourCounts[hour] <= avgPerHour * 0.3 && sessions.length > 5) {
        reasons.push('unusual_hour');
        score += 20;
      }

      if (s.revokedAt) {
        const lifetime = new Date(s.revokedAt).getTime() - new Date(s.createdAt).getTime();
        if (lifetime < 60000) {
          reasons.push('very_short_session');
          score += 25;
        }
      }

      if (reasons.length > 0) {
        flaggedSessions.push({ sessionId: s.id, reasons, anomalyScore: Math.min(100, score) });
      }
    }

    flaggedSessions.sort((a, b) => b.anomalyScore - a.anomalyScore);
    const anomalyRate = Math.round((flaggedSessions.length / sessions.length) * 10000) / 100;

    const riskLevel = anomalyRate >= 50 ? 'high'
      : anomalyRate >= 25 ? 'moderate'
      : anomalyRate > 0 ? 'low'
      : 'none';

    return {
      totalSessions: sessions.length,
      anomalyCount: flaggedSessions.length,
      anomalyRate,
      riskLevel,
      flaggedSessions: flaggedSessions.slice(0, 10),
    };
  }

  async getSessionDeviceFingerprinting(userId: string) {
    const sessions = await this.prisma.userSession.findMany({ where: { userId } });
    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        uniqueDevices: 0,
        uniqueIPs: 0,
        deviceBreakdown: [],
        ipBreakdown: [],
        sharingRisk: 'none',
      };
    }

    const deviceMap = new Map<string, { count: number; lastSeen: Date; ips: Set<string> }>();
    const ipMap = new Map<string, { count: number; lastSeen: Date; devices: Set<string> }>();

    for (const s of sessions) {
      const device = (s as any).userAgent || (s as any).deviceName || 'unknown';
      const ip = s.ip || 'unknown';

      if (!deviceMap.has(device)) {
        deviceMap.set(device, { count: 0, lastSeen: s.createdAt, ips: new Set() });
      }
      const dEntry = deviceMap.get(device)!;
      dEntry.count++;
      if (s.createdAt > dEntry.lastSeen) dEntry.lastSeen = s.createdAt;
      dEntry.ips.add(ip);

      if (!ipMap.has(ip)) {
        ipMap.set(ip, { count: 0, lastSeen: s.createdAt, devices: new Set() });
      }
      const iEntry = ipMap.get(ip)!;
      iEntry.count++;
      if (s.createdAt > iEntry.lastSeen) iEntry.lastSeen = s.createdAt;
      iEntry.devices.add(device);
    }

    const deviceBreakdown = Array.from(deviceMap.entries())
      .map(([device, d]) => ({ device, sessionCount: d.count, uniqueIPs: d.ips.size, lastSeen: d.lastSeen }))
      .sort((a, b) => b.sessionCount - a.sessionCount);

    const ipBreakdown = Array.from(ipMap.entries())
      .map(([ip, d]) => ({ ip, sessionCount: d.count, uniqueDevices: d.devices.size, lastSeen: d.lastSeen }))
      .sort((a, b) => b.sessionCount - a.sessionCount);

    const maxDevicesPerIp = Math.max(...ipBreakdown.map(i => i.uniqueDevices));
    const sharingRisk = maxDevicesPerIp >= 5 ? 'high'
      : maxDevicesPerIp >= 3 ? 'moderate'
      : maxDevicesPerIp >= 2 ? 'low'
      : 'none';

    return {
      totalSessions: sessions.length,
      uniqueDevices: deviceMap.size,
      uniqueIPs: ipMap.size,
      deviceBreakdown: deviceBreakdown.slice(0, 10),
      ipBreakdown: ipBreakdown.slice(0, 10),
      sharingRisk,
    };
  }

  async getSessionConcurrencyAnalysis(userId: string) {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        activeSessions: 0,
        peakConcurrent: 0,
        avgSessionDurationHours: 0,
        concurrencyLevel: 'none' as const,
        recommendations: [] as string[],
      };
    }

    const active = sessions.filter(s => ((s as any).status || '').toLowerCase() === 'active');
    const now = Date.now();

    let longestDuration = 0;
    let totalDuration = 0;
    let withDuration = 0;

    for (const s of sessions) {
      const start = new Date(s.createdAt).getTime();
      const end = (s as any).revokedAt ? new Date((s as any).revokedAt).getTime() : now;
      const duration = end - start;
      totalDuration += duration;
      withDuration++;
      if (duration > longestDuration) longestDuration = duration;
    }

    const avgDurationHours = withDuration > 0
      ? Number((totalDuration / withDuration / 3600000).toFixed(2))
      : 0;

    const peakConcurrent = active.length;

    const concurrencyLevel = peakConcurrent >= 5 ? 'high' as const
      : peakConcurrent >= 3 ? 'moderate' as const
      : peakConcurrent >= 1 ? 'low' as const
      : 'none' as const;

    const recommendations: string[] = [];
    if (peakConcurrent >= 5) recommendations.push('High number of concurrent sessions — consider revoking unused ones');
    if (avgDurationHours > 720) recommendations.push('Sessions remain active for very long periods — enable session expiry');
    if (active.length > sessions.length * 0.8) recommendations.push('Most sessions are still active — review session cleanup policy');

    return {
      totalSessions: sessions.length,
      activeSessions: active.length,
      peakConcurrent,
      avgSessionDurationHours: avgDurationHours,
      concurrencyLevel,
      recommendations,
    };
  }

  async getSessionRiskIndicators(userId: string) {
    const sessions = await this.prisma.userSession.findMany({ where: { userId } });

    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        riskLevel: 'no_data' as const,
        riskScore: 0,
        indicators: [],
        recommendations: [],
      };
    }

    const indicators: { indicator: string; value: number | string; severity: string }[] = [];

    const ipSet = new Set<string>();
    const deviceSet = new Set<string>();
    const locationSet = new Set<string>();

    for (const s of sessions) {
      if ((s as any).ipAddress) ipSet.add((s as any).ipAddress);
      if ((s as any).deviceId || (s as any).userAgent) deviceSet.add((s as any).deviceId || (s as any).userAgent);
      if ((s as any).location || (s as any).country) locationSet.add((s as any).location || (s as any).country);
    }

    indicators.push({
      indicator: 'unique_ips',
      value: ipSet.size,
      severity: ipSet.size > 10 ? 'high' : ipSet.size > 5 ? 'medium' : 'low',
    });

    indicators.push({
      indicator: 'unique_devices',
      value: deviceSet.size,
      severity: deviceSet.size > 5 ? 'high' : deviceSet.size > 3 ? 'medium' : 'low',
    });

    indicators.push({
      indicator: 'unique_locations',
      value: locationSet.size,
      severity: locationSet.size > 5 ? 'high' : locationSet.size > 3 ? 'medium' : 'low',
    });

    const now = Date.now();
    const activeSessions = sessions.filter(s => {
      const expiresAt = (s as any).expiresAt;
      return expiresAt ? new Date(expiresAt).getTime() > now : true;
    });

    indicators.push({
      indicator: 'active_sessions',
      value: activeSessions.length,
      severity: activeSessions.length > 10 ? 'high' : activeSessions.length > 5 ? 'medium' : 'low',
    });

    const highCount = indicators.filter(i => i.severity === 'high').length;
    const mediumCount = indicators.filter(i => i.severity === 'medium').length;

    let riskScore = 0;
    riskScore += highCount * 25;
    riskScore += mediumCount * 10;
    riskScore = Math.min(100, riskScore);

    const riskLevel = riskScore >= 50 ? 'high' : riskScore >= 25 ? 'moderate' : 'low';

    const recommendations: string[] = [];
    if (ipSet.size > 10) recommendations.push('Many unique IPs — check for unauthorized access');
    if (deviceSet.size > 5) recommendations.push('Multiple devices — review active sessions');
    if (activeSessions.length > 10) recommendations.push('Too many active sessions — revoke unused');

    return {
      totalSessions: sessions.length,
      riskLevel,
      riskScore,
      activeSessions: activeSessions.length,
      uniqueIps: ipSet.size,
      uniqueDevices: deviceSet.size,
      indicators,
      recommendations,
    };
  }
}
