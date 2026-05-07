import type { PrismaClient } from '@prisma/client';

export interface AuditEntry {
  userId?: string | null;
  actor: 'user' | 'system' | 'agent' | 'webhook' | 'admin';
  eventType: string;
  payload?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export async function audit(prisma: PrismaClient, e: AuditEntry) {
  await prisma.event
    .create({
      data: {
        userId: e.userId ?? null,
        actor: e.actor,
        eventType: e.eventType,
        payload: (e.payload ?? {}) as object,
        requestId: e.requestId,
        ip: e.ip,
        userAgent: e.userAgent,
      },
    })
    .catch(() => {
      // audit is best-effort; never break the request
    });
}
