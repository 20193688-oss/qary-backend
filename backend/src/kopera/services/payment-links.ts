import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

export class PaymentLinkService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    amount: bigint;
    currency: string;
    description?: string;
    expiresAt?: Date;
    singleUse?: boolean;
  }) {
    const code = randomBytes(12).toString('base64url');

    return this.prisma.paymentLink.create({
      data: {
        userId: params.userId,
        code,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        description: params.description ?? null,
        status: 'active',
        singleUse: params.singleUse ?? true,
        expiresAt: params.expiresAt ?? null,
        timesUsed: 0,
      },
    });
  }

  async getByCode(code: string) {
    const link = await this.prisma.paymentLink.findFirst({ where: { code } });
    if (!link) return null;
    if (link.status !== 'active') return link;
    if (link.expiresAt && link.expiresAt < new Date()) {
      await this.prisma.paymentLink.update({
        where: { id: link.id },
        data: { status: 'expired' },
      });
      return { ...link, status: 'expired' };
    }
    return link;
  }

  async getById(id: string) {
    return this.prisma.paymentLink.findUnique({ where: { id } });
  }

  async listByUser(userId: string) {
    return this.prisma.paymentLink.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markUsed(id: string) {
    const link = await this.prisma.paymentLink.findUnique({ where: { id } });
    if (!link) throw new Error('link_not_found');
    if (link.status !== 'active') throw new Error('link_not_active');

    return this.prisma.paymentLink.update({
      where: { id },
      data: {
        timesUsed: link.timesUsed + 1,
        lastUsedAt: new Date(),
        status: link.singleUse ? 'used' : 'active',
      },
    });
  }

  async deactivate(id: string, userId: string) {
    const link = await this.prisma.paymentLink.findUnique({ where: { id } });
    if (!link) throw new Error('link_not_found');
    if (link.userId !== userId) throw new Error('forbidden');
    if (link.status === 'deactivated') throw new Error('already_deactivated');

    return this.prisma.paymentLink.update({
      where: { id },
      data: { status: 'deactivated' },
    });
  }
}
