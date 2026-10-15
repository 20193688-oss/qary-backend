import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class DirectDebitService {
  constructor(private prisma: PrismaClient) {}

  async createMandate(userId: string, data: {
    creditorName: string;
    creditorAccount: string;
    amount: bigint;
    currency: string;
    frequency: string;
    description?: string;
  }) {
    return this.prisma.directDebitMandate.create({
      data: {
        userId,
        creditorName: data.creditorName,
        creditorAccount: data.creditorAccount,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        frequency: data.frequency.toUpperCase(),
        description: data.description || null,
        status: 'ACTIVE',
        collectionsCount: 0,
        totalCollected: BigInt(0),
        reference: `DDM-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getMandates(userId: string) {
    return this.prisma.directDebitMandate.findMany({ where: { userId } });
  }

  async getMandate(userId: string, id: string) {
    const m = await this.prisma.directDebitMandate.findUnique({ where: { id } });
    if (!m) throw new Error('mandate_not_found');
    if ((m as any).userId !== userId) throw new Error('mandate_not_found');
    return m;
  }

  async collectPayment(userId: string, id: string) {
    const m = await this.getMandate(userId, id);
    if ((m as any).status !== 'ACTIVE') throw new Error('mandate_not_active');

    const newTotal = ((m as any).totalCollected as bigint) + ((m as any).amount as bigint);

    return this.prisma.directDebitMandate.update({
      where: { id },
      data: {
        collectionsCount: ((m as any).collectionsCount || 0) + 1,
        totalCollected: newTotal,
        lastCollectedAt: new Date(),
      },
    });
  }

  async suspendMandate(userId: string, id: string) {
    const m = await this.getMandate(userId, id);
    if ((m as any).status !== 'ACTIVE') throw new Error('mandate_not_active');

    return this.prisma.directDebitMandate.update({
      where: { id },
      data: { status: 'SUSPENDED', suspendedAt: new Date() },
    });
  }

  async reactivateMandate(userId: string, id: string) {
    const m = await this.getMandate(userId, id);
    if ((m as any).status !== 'SUSPENDED') throw new Error('mandate_not_suspended');

    return this.prisma.directDebitMandate.update({
      where: { id },
      data: { status: 'ACTIVE', suspendedAt: null },
    });
  }

  async cancelMandate(userId: string, id: string) {
    const m = await this.getMandate(userId, id);
    if ((m as any).status === 'CANCELLED') throw new Error('mandate_already_cancelled');

    return this.prisma.directDebitMandate.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getMandateAnalytics(userId: string) {
    const mandates = await this.prisma.directDebitMandate.findMany({ where: { userId } });

    if (mandates.length === 0) {
      return {
        totalMandates: 0,
        breakdown: { ACTIVE: 0, SUSPENDED: 0, CANCELLED: 0 },
        totalCollected: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ACTIVE: 0, SUSPENDED: 0, CANCELLED: 0 };
    let totalCollected = BigInt(0);
    for (const m of mandates as any[]) {
      const status = m.status as string;
      if (status in breakdown) breakdown[status]++;
      totalCollected += (m.totalCollected as bigint) || BigInt(0);
    }

    return {
      totalMandates: mandates.length,
      breakdown,
      totalCollected: totalCollected.toString(),
      analyticsLevel: mandates.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
