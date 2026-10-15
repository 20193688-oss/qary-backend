import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class ChargebackService {
  constructor(private prisma: PrismaClient) {}

  async fileChargeback(userId: string, data: {
    transactionRef: string;
    amount: bigint;
    currency: string;
    reason: string;
    cardLast4: string;
  }) {
    return this.prisma.chargeback.create({
      data: {
        userId,
        transactionRef: data.transactionRef,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        reason: data.reason,
        cardLast4: data.cardLast4,
        status: 'FILED',
        filedAt: new Date(),
        reference: `CHB-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getChargebacks(userId: string) {
    return this.prisma.chargeback.findMany({ where: { userId } });
  }

  async getChargeback(userId: string, id: string) {
    const cb = await this.prisma.chargeback.findUnique({ where: { id } });
    if (!cb) throw new Error('chargeback_not_found');
    if ((cb as any).userId !== userId) throw new Error('chargeback_not_found');
    return cb;
  }

  async submitEvidence(userId: string, id: string, evidence: string) {
    const cb = await this.getChargeback(userId, id);
    if ((cb as any).status !== 'FILED') throw new Error('chargeback_not_filed');

    return this.prisma.chargeback.update({
      where: { id },
      data: { status: 'UNDER_REVIEW', evidence, evidenceSubmittedAt: new Date() },
    });
  }

  async resolveChargeback(userId: string, id: string, outcome: string) {
    const cb = await this.getChargeback(userId, id);
    if ((cb as any).status !== 'UNDER_REVIEW' && (cb as any).status !== 'FILED') throw new Error('chargeback_not_resolvable');

    return this.prisma.chargeback.update({
      where: { id },
      data: { status: outcome === 'WON' ? 'WON' : 'LOST', outcome, resolvedAt: new Date() },
    });
  }

  async cancelChargeback(userId: string, id: string) {
    const cb = await this.getChargeback(userId, id);
    if ((cb as any).status !== 'FILED') throw new Error('chargeback_not_filed');

    return this.prisma.chargeback.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getChargebackAnalytics(userId: string) {
    const chargebacks = await this.prisma.chargeback.findMany({ where: { userId } });

    if (chargebacks.length === 0) {
      return {
        totalChargebacks: 0,
        breakdown: { FILED: 0, UNDER_REVIEW: 0, WON: 0, LOST: 0, CANCELLED: 0 },
        totalAmount: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { FILED: 0, UNDER_REVIEW: 0, WON: 0, LOST: 0, CANCELLED: 0 };
    let totalAmount = BigInt(0);
    for (const cb of chargebacks as any[]) {
      if (cb.status in breakdown) breakdown[cb.status]++;
      totalAmount += cb.amount as bigint;
    }

    return {
      totalChargebacks: chargebacks.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      analyticsLevel: chargebacks.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
