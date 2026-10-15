import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class EscrowService {
  constructor(private prisma: PrismaClient) {}

  async createEscrow(userId: string, data: {
    counterpartyName: string;
    counterpartyEmail: string;
    amount: bigint;
    currency: string;
    description: string;
    expiresAt?: Date;
  }) {
    return this.prisma.escrow.create({
      data: {
        userId,
        counterpartyName: data.counterpartyName,
        counterpartyEmail: data.counterpartyEmail,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        description: data.description,
        status: 'FUNDED',
        expiresAt: data.expiresAt || null,
        reference: `ESC-${Date.now()}-${randomUUID().slice(0, 8)}`,
        fundedAt: new Date(),
      },
    });
  }

  async getEscrows(userId: string) {
    return this.prisma.escrow.findMany({ where: { userId } });
  }

  async getEscrow(userId: string, id: string) {
    const e = await this.prisma.escrow.findUnique({ where: { id } });
    if (!e) throw new Error('escrow_not_found');
    if ((e as any).userId !== userId) throw new Error('escrow_not_found');
    return e;
  }

  async releaseEscrow(userId: string, id: string) {
    const e = await this.getEscrow(userId, id);
    if ((e as any).status !== 'FUNDED') throw new Error('escrow_not_funded');

    return this.prisma.escrow.update({
      where: { id },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  }

  async disputeEscrow(userId: string, id: string, reason: string) {
    const e = await this.getEscrow(userId, id);
    if ((e as any).status !== 'FUNDED') throw new Error('escrow_not_funded');

    return this.prisma.escrow.update({
      where: { id },
      data: { status: 'DISPUTED', disputeReason: reason, disputedAt: new Date() },
    });
  }

  async refundEscrow(userId: string, id: string) {
    const e = await this.getEscrow(userId, id);
    if ((e as any).status !== 'FUNDED' && (e as any).status !== 'DISPUTED') throw new Error('escrow_cannot_refund');

    return this.prisma.escrow.update({
      where: { id },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });
  }

  async getEscrowAnalytics(userId: string) {
    const escrows = await this.prisma.escrow.findMany({ where: { userId } });

    if (escrows.length === 0) {
      return {
        totalEscrows: 0,
        breakdown: { FUNDED: 0, RELEASED: 0, DISPUTED: 0, REFUNDED: 0 },
        totalAmount: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { FUNDED: 0, RELEASED: 0, DISPUTED: 0, REFUNDED: 0 };
    let totalAmount = BigInt(0);
    for (const e of escrows as any[]) {
      const status = e.status as string;
      if (status in breakdown) breakdown[status]++;
      totalAmount += e.amount as bigint;
    }

    return {
      totalEscrows: escrows.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      analyticsLevel: escrows.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
