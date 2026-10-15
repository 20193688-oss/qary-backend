import type { PrismaClient } from '@prisma/client';
import { randomUUID, randomInt } from 'node:crypto';

export class AccountVerificationService {
  constructor(private prisma: PrismaClient) {}

  async initiateVerification(userId: string, data: {
    verificationType: string;
    method: string;
    target: string;
  }) {
    const code = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    return this.prisma.accountVerification.create({
      data: {
        userId,
        verificationType: data.verificationType.toUpperCase(),
        method: data.method.toUpperCase(),
        target: data.target,
        code,
        status: 'PENDING',
        attempts: 0,
        maxAttempts: 5,
        expiresAt,
        reference: `AVR-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getVerifications(userId: string) {
    return this.prisma.accountVerification.findMany({ where: { userId } });
  }

  async getVerification(userId: string, id: string) {
    const v = await this.prisma.accountVerification.findUnique({ where: { id } });
    if (!v) throw new Error('verification_not_found');
    if ((v as any).userId !== userId) throw new Error('verification_not_found');
    return v;
  }

  async confirmVerification(userId: string, id: string, code: string) {
    const v = await this.getVerification(userId, id);
    if ((v as any).status !== 'PENDING') throw new Error('verification_not_pending');
    if ((v as any).attempts >= (v as any).maxAttempts) throw new Error('max_attempts_exceeded');

    if ((v as any).code !== code) {
      await this.prisma.accountVerification.update({
        where: { id },
        data: { attempts: ((v as any).attempts || 0) + 1 },
      });
      throw new Error('invalid_verification_code');
    }

    return this.prisma.accountVerification.update({
      where: { id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
  }

  async cancelVerification(userId: string, id: string) {
    const v = await this.getVerification(userId, id);
    if ((v as any).status !== 'PENDING') throw new Error('verification_not_pending');

    return this.prisma.accountVerification.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async resendCode(userId: string, id: string) {
    const v = await this.getVerification(userId, id);
    if ((v as any).status !== 'PENDING') throw new Error('verification_not_pending');

    const newCode = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    return this.prisma.accountVerification.update({
      where: { id },
      data: { code: newCode, expiresAt, attempts: 0 },
    });
  }

  async getVerificationAnalytics(userId: string) {
    const vers = await this.prisma.accountVerification.findMany({ where: { userId } });

    if (vers.length === 0) {
      return {
        totalVerifications: 0,
        breakdown: { PENDING: 0, VERIFIED: 0, CANCELLED: 0 },
        methods: {},
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, VERIFIED: 0, CANCELLED: 0 };
    const methods: Record<string, number> = {};
    for (const v of vers as any[]) {
      const status = v.status as string;
      if (status in breakdown) breakdown[status]++;
      methods[v.method] = (methods[v.method] || 0) + 1;
    }

    return {
      totalVerifications: vers.length,
      breakdown,
      methods,
      analyticsLevel: vers.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
