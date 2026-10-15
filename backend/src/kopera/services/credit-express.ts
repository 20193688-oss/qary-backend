import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class CreditExpressService {
  constructor(private prisma: PrismaClient) {}

  async applyForCredit(userId: string, data: {
    currency: string;
    requestedAmount: bigint;
    termMonths: number;
    purpose: string;
  }) {
    const existing = await this.prisma.creditLine.findFirst({
      where: { userId, currency: data.currency.toUpperCase(), status: 'ACTIVE' },
    });
    if (existing) throw new Error('active_credit_line_exists');

    return this.prisma.creditLine.create({
      data: {
        userId,
        currency: data.currency.toUpperCase(),
        creditLimit: data.requestedAmount,
        availableCredit: data.requestedAmount,
        usedCredit: BigInt(0),
        termMonths: data.termMonths,
        interestRate: 0.12,
        purpose: data.purpose,
        status: 'PENDING_APPROVAL',
        reference: `CRD-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getCreditLines(userId: string) {
    return this.prisma.creditLine.findMany({ where: { userId } });
  }

  async getCreditLine(userId: string, id: string) {
    const line = await this.prisma.creditLine.findUnique({ where: { id } });
    if (!line) throw new Error('credit_line_not_found');
    if ((line as any).userId !== userId) throw new Error('credit_line_not_found');
    return line;
  }

  async approveCreditLine(id: string) {
    const line = await this.prisma.creditLine.findUnique({ where: { id } });
    if (!line) throw new Error('credit_line_not_found');
    if ((line as any).status !== 'PENDING_APPROVAL') throw new Error('invalid_status');
    return this.prisma.creditLine.update({
      where: { id },
      data: { status: 'ACTIVE', approvedAt: new Date() },
    });
  }

  async disburse(userId: string, creditLineId: string, amount: bigint, targetCurrency?: string) {
    const line = await this.getCreditLine(userId, creditLineId);
    if ((line as any).status !== 'ACTIVE') throw new Error('credit_line_not_active');
    const available = (line as any).availableCredit as bigint;
    if (amount > available) throw new Error('insufficient_credit');

    const disbursement = await this.prisma.creditDisbursement.create({
      data: {
        creditLineId,
        userId,
        amount,
        currency: (line as any).currency,
        targetCurrency: targetCurrency?.toUpperCase() || (line as any).currency,
        status: 'COMPLETED',
        reference: `DSB-${Date.now()}-${randomUUID().slice(0, 8)}`,
        disbursedAt: new Date(),
      },
    });

    await this.prisma.creditLine.update({
      where: { id: creditLineId },
      data: {
        usedCredit: BigInt(Number(available) - Number(available) + Number((line as any).usedCredit) + Number(amount)),
        availableCredit: available - amount,
      },
    });

    return disbursement;
  }

  async repay(userId: string, creditLineId: string, amount: bigint) {
    const line = await this.getCreditLine(userId, creditLineId);
    const used = (line as any).usedCredit as bigint;
    if (amount > used) throw new Error('repayment_exceeds_balance');

    const repayment = await this.prisma.creditRepayment.create({
      data: {
        creditLineId,
        userId,
        amount,
        currency: (line as any).currency,
        status: 'COMPLETED',
        reference: `RPY-${Date.now()}-${randomUUID().slice(0, 8)}`,
        paidAt: new Date(),
      },
    });

    await this.prisma.creditLine.update({
      where: { id: creditLineId },
      data: {
        usedCredit: used - amount,
        availableCredit: ((line as any).availableCredit as bigint) + amount,
      },
    });

    return repayment;
  }

  async getCreditSummary(userId: string) {
    const lines = await this.prisma.creditLine.findMany({ where: { userId } });
    const active = lines.filter((l: any) => l.status === 'ACTIVE');
    const totalLimit = active.reduce((s: bigint, l: any) => s + (l.creditLimit as bigint), BigInt(0));
    const totalUsed = active.reduce((s: bigint, l: any) => s + (l.usedCredit as bigint), BigInt(0));
    const totalAvailable = active.reduce((s: bigint, l: any) => s + (l.availableCredit as bigint), BigInt(0));
    const currencies = [...new Set(active.map((l: any) => l.currency))];

    const utilizationRate = totalLimit > BigInt(0)
      ? Number(totalUsed) / Number(totalLimit)
      : 0;

    let healthLevel: string;
    if (lines.length === 0) healthLevel = 'no_data';
    else if (utilizationRate < 0.3) healthLevel = 'excellent';
    else if (utilizationRate < 0.6) healthLevel = 'good';
    else if (utilizationRate < 0.8) healthLevel = 'caution';
    else healthLevel = 'overleveraged';

    return {
      totalLines: lines.length,
      activeLines: active.length,
      totalLimit: totalLimit.toString(),
      totalUsed: totalUsed.toString(),
      totalAvailable: totalAvailable.toString(),
      utilizationRate: Math.round(utilizationRate * 100),
      currencies,
      healthLevel,
    };
  }
}
