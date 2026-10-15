import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

export class AuditTrailService {
  constructor(private prisma: PrismaClient) {}

  async logAction(userId: string, data: {
    action: string;
    resourceType: string;
    resourceId: string;
    details?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const hash = createHash('sha256')
      .update(`${userId}:${data.action}:${data.resourceType}:${data.resourceId}:${Date.now()}`)
      .digest('hex');

    return this.prisma.auditTrailEntry.create({
      data: {
        userId,
        action: data.action,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        details: data.details || null,
        ipAddress: data.ipAddress || null,
        userAgent: data.userAgent || null,
        integrityHash: hash,
        reference: `AUD-${Date.now()}-${randomUUID().slice(0, 8)}`,
        performedAt: new Date(),
      },
    });
  }

  async getEntries(userId: string) {
    return this.prisma.auditTrailEntry.findMany({ where: { userId } });
  }

  async getEntry(userId: string, id: string) {
    const entry = await this.prisma.auditTrailEntry.findUnique({ where: { id } });
    if (!entry) throw new Error('entry_not_found');
    if ((entry as any).userId !== userId) throw new Error('entry_not_found');
    return entry;
  }

  async getByResource(userId: string, resourceType: string, resourceId: string) {
    const entries = await this.prisma.auditTrailEntry.findMany({ where: { userId } });
    return (entries as any[]).filter(
      (e) => e.resourceType === resourceType && e.resourceId === resourceId,
    );
  }

  async verifyIntegrity(userId: string, id: string) {
    const entry = await this.getEntry(userId, id);
    const e = entry as any;
    const expectedHash = createHash('sha256')
      .update(`${e.userId}:${e.action}:${e.resourceType}:${e.resourceId}:${new Date(e.performedAt).getTime()}`)
      .digest('hex');

    return {
      id: e.id,
      integrityValid: e.integrityHash === expectedHash,
      storedHash: e.integrityHash,
    };
  }

  async getAuditAnalytics(userId: string) {
    const entries = await this.prisma.auditTrailEntry.findMany({ where: { userId } });

    if (entries.length === 0) {
      return {
        totalEntries: 0,
        actionBreakdown: {},
        resourceBreakdown: {},
        analyticsLevel: 'no_data',
      };
    }

    const actionBreakdown: Record<string, number> = {};
    const resourceBreakdown: Record<string, number> = {};

    for (const e of entries as any[]) {
      actionBreakdown[e.action] = (actionBreakdown[e.action] || 0) + 1;
      resourceBreakdown[e.resourceType] = (resourceBreakdown[e.resourceType] || 0) + 1;
    }

    return {
      totalEntries: entries.length,
      actionBreakdown,
      resourceBreakdown,
      analyticsLevel: entries.length >= 10 ? 'sufficient' : 'limited',
    };
  }
}
