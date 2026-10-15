import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class WireTransferService {
  constructor(private prisma: PrismaClient) {}

  async initiateTransfer(userId: string, data: {
    recipientName: string;
    recipientBank: string;
    recipientAccount: string;
    amount: bigint;
    currency: string;
    swiftCode?: string;
    memo?: string;
  }) {
    return this.prisma.wireTransfer.create({
      data: {
        userId,
        recipientName: data.recipientName,
        recipientBank: data.recipientBank,
        recipientAccount: data.recipientAccount,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        swiftCode: data.swiftCode || null,
        memo: data.memo || null,
        fee: BigInt(Math.round(Number(data.amount) * 0.002)),
        status: 'INITIATED',
        reference: `WIR-${Date.now()}-${randomUUID().slice(0, 8)}`,
        initiatedAt: new Date(),
      },
    });
  }

  async getTransfers(userId: string) {
    return this.prisma.wireTransfer.findMany({ where: { userId } });
  }

  async getTransfer(userId: string, id: string) {
    const t = await this.prisma.wireTransfer.findUnique({ where: { id } });
    if (!t) throw new Error('wire_transfer_not_found');
    if ((t as any).userId !== userId) throw new Error('wire_transfer_not_found');
    return t;
  }

  async approveTransfer(userId: string, id: string) {
    const t = await this.getTransfer(userId, id);
    if ((t as any).status !== 'INITIATED') throw new Error('wire_not_initiated');

    return this.prisma.wireTransfer.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
  }

  async completeTransfer(userId: string, id: string) {
    const t = await this.getTransfer(userId, id);
    if ((t as any).status !== 'APPROVED') throw new Error('wire_not_approved');

    return this.prisma.wireTransfer.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  }

  async cancelTransfer(userId: string, id: string) {
    const t = await this.getTransfer(userId, id);
    if ((t as any).status === 'COMPLETED') throw new Error('wire_already_completed');
    if ((t as any).status === 'CANCELLED') throw new Error('wire_already_cancelled');

    return this.prisma.wireTransfer.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getTransferAnalytics(userId: string) {
    const transfers = await this.prisma.wireTransfer.findMany({ where: { userId } });

    if (transfers.length === 0) {
      return {
        totalTransfers: 0,
        breakdown: { INITIATED: 0, APPROVED: 0, COMPLETED: 0, CANCELLED: 0 },
        totalAmount: '0',
        totalFees: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { INITIATED: 0, APPROVED: 0, COMPLETED: 0, CANCELLED: 0 };
    let totalAmount = BigInt(0);
    let totalFees = BigInt(0);
    for (const t of transfers as any[]) {
      const status = t.status as string;
      if (status in breakdown) breakdown[status]++;
      totalAmount += t.amount as bigint;
      totalFees += (t.fee as bigint) || BigInt(0);
    }

    return {
      totalTransfers: transfers.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      totalFees: totalFees.toString(),
      analyticsLevel: transfers.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
