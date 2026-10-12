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
