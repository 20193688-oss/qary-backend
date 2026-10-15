import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const CONFIRMATION_TIMEOUT_MS = 20 * 60 * 1000;

export class SafePayService {
  constructor(private prisma: PrismaClient) {}

  async createConfirmation(userId: string, data: {
    transactionId?: string;
    amount: bigint;
    currency: string;
    merchantName: string;
    merchantId?: string;
    channel: string;
  }) {
    const confirmationCode = this.generateCode();
    const expiresAt = new Date(Date.now() + CONFIRMATION_TIMEOUT_MS);

    return this.prisma.safePayConfirmation.create({
      data: {
        userId,
        transactionId: data.transactionId || null,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        merchantName: data.merchantName,
        merchantId: data.merchantId || null,
        channel: data.channel,
        confirmationCode,
        status: 'PENDING',
        expiresAt,
        reference: `SPY-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async confirmPayment(userId: string, confirmationId: string, data: {
    confirmationCode: string;
    secretKey?: string;
  }) {
    const confirmation = await this.prisma.safePayConfirmation.findUnique({
      where: { id: confirmationId },
    });
    if (!confirmation) throw new Error('confirmation_not_found');
    if ((confirmation as any).userId !== userId) throw new Error('confirmation_not_found');
    if ((confirmation as any).status !== 'PENDING') throw new Error('confirmation_already_resolved');

    const now = new Date();
    if (now > (confirmation as any).expiresAt) {
      await this.prisma.safePayConfirmation.update({
        where: { id: confirmationId },
        data: { status: 'EXPIRED', resolvedAt: now },
      });
      throw new Error('confirmation_expired');
    }

    if (data.confirmationCode !== (confirmation as any).confirmationCode) {
      const attempts = ((confirmation as any).failedAttempts || 0) + 1;
      await this.prisma.safePayConfirmation.update({
        where: { id: confirmationId },
        data: { failedAttempts: attempts },
      });
      if (attempts >= 3) {
        await this.prisma.safePayConfirmation.update({
          where: { id: confirmationId },
          data: { status: 'BLOCKED', resolvedAt: now },
        });
        throw new Error('confirmation_blocked');
      }
      throw new Error('invalid_confirmation_code');
    }

    if (data.secretKey) {
      const userKey = await this.prisma.userSecretKey.findFirst({
        where: { userId, isActive: true },
      });
      if (!userKey || (userKey as any).keyHash !== data.secretKey) {
        throw new Error('invalid_secret_key');
      }
    }

    return this.prisma.safePayConfirmation.update({
      where: { id: confirmationId },
      data: { status: 'CONFIRMED', resolvedAt: now, confirmedAt: now },
    });
  }

  async cancelConfirmation(userId: string, confirmationId: string) {
    const confirmation = await this.prisma.safePayConfirmation.findUnique({
      where: { id: confirmationId },
    });
    if (!confirmation) throw new Error('confirmation_not_found');
    if ((confirmation as any).userId !== userId) throw new Error('confirmation_not_found');
    if ((confirmation as any).status !== 'PENDING') throw new Error('confirmation_already_resolved');

    return this.prisma.safePayConfirmation.update({
      where: { id: confirmationId },
      data: { status: 'CANCELLED', resolvedAt: new Date() },
    });
  }

  async getConfirmations(userId: string) {
    return this.prisma.safePayConfirmation.findMany({ where: { userId } });
  }

  async getPendingConfirmations(userId: string) {
    const all = await this.prisma.safePayConfirmation.findMany({
      where: { userId, status: 'PENDING' },
    });
    const now = new Date();
    const pending: any[] = [];
    for (const c of all as any[]) {
      if (now > c.expiresAt) {
        await this.prisma.safePayConfirmation.update({
          where: { id: c.id },
          data: { status: 'EXPIRED', resolvedAt: now },
        });
      } else {
        pending.push(c);
      }
    }
    return pending;
  }

  async getConfirmationMetrics(userId: string) {
    const confirmations = await this.prisma.safePayConfirmation.findMany({ where: { userId } });

    if (confirmations.length === 0) {
      return {
        totalConfirmations: 0,
        breakdown: { confirmed: 0, cancelled: 0, expired: 0, blocked: 0, pending: 0 },
        confirmationRate: 0,
        avgResponseTime: 0,
        metricsLevel: 'no_data',
      };
    }

    const breakdown = { confirmed: 0, cancelled: 0, expired: 0, blocked: 0, pending: 0 };
    let totalResponseMs = 0;
    let responseCount = 0;

    for (const c of confirmations as any[]) {
      const status = c.status.toLowerCase() as keyof typeof breakdown;
      if (status in breakdown) breakdown[status]++;
      if (c.confirmedAt && c.createdAt) {
        totalResponseMs += new Date(c.confirmedAt).getTime() - new Date(c.createdAt).getTime();
        responseCount++;
      }
    }

    const confirmationRate = confirmations.length > 0
      ? Math.round((breakdown.confirmed / confirmations.length) * 100)
      : 0;

    const avgResponseTime = responseCount > 0
      ? Math.round(totalResponseMs / responseCount / 1000)
      : 0;

    let metricsLevel: string;
    if (confirmationRate >= 80) metricsLevel = 'healthy';
    else if (confirmationRate >= 50) metricsLevel = 'moderate';
    else metricsLevel = 'concerning';

    return {
      totalConfirmations: confirmations.length,
      breakdown,
      confirmationRate,
      avgResponseTime,
      metricsLevel,
    };
  }

  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
