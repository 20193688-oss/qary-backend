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
}
