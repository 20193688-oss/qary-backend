import type { PrismaClient } from '@prisma/client';

export class MerchantContractService {
  constructor(private prisma: PrismaClient) {}

  async createContract(userId: string, data: {
    merchantId: string;
    contractType: string;
    startDate: string;
    endDate: string;
    terms: string;
    monthlyFee: bigint;
  }) {
    return this.prisma.merchantContract.create({
      data: {
        userId,
        merchantId: data.merchantId,
        contractType: data.contractType.toUpperCase(),
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        terms: data.terms,
        monthlyFee: data.monthlyFee,
        status: 'DRAFT',
        totalBilled: BigInt(0),
        billingCycles: 0,
      },
    });
  }

  async getContracts(userId: string) {
    return this.prisma.merchantContract.findMany({ where: { userId } });
  }

  async getContract(userId: string, id: string) {
    const c = await this.prisma.merchantContract.findFirst({ where: { id, userId } });
    if (!c) throw new Error('contract_not_found');
    return c;
  }

  async activateContract(userId: string, id: string) {
    const c = await this.prisma.merchantContract.findFirst({ where: { id, userId } });
    if (!c) throw new Error('contract_not_found');
    if (c.status !== 'DRAFT') throw new Error('contract_not_draft');
    return this.prisma.merchantContract.update({
      where: { id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
  }

  async billCycle(userId: string, id: string) {
    const c = await this.prisma.merchantContract.findFirst({ where: { id, userId } });
    if (!c) throw new Error('contract_not_found');
    if (c.status !== 'ACTIVE') throw new Error('contract_not_active');
    return this.prisma.merchantContract.update({
      where: { id },
      data: {
        billingCycles: c.billingCycles + 1,
        totalBilled: (c.totalBilled ?? BigInt(0)) + (c.monthlyFee ?? BigInt(0)),
        lastBilledAt: new Date(),
      },
    });
  }

  async terminateContract(userId: string, id: string, reason: string) {
    const c = await this.prisma.merchantContract.findFirst({ where: { id, userId } });
    if (!c) throw new Error('contract_not_found');
    if (c.status !== 'ACTIVE') throw new Error('contract_not_active');
    return this.prisma.merchantContract.update({
      where: { id },
      data: { status: 'TERMINATED', terminationReason: reason, terminatedAt: new Date() },
    });
  }

  async renewContract(userId: string, id: string, newEndDate: string) {
    const c = await this.prisma.merchantContract.findFirst({ where: { id, userId } });
    if (!c) throw new Error('contract_not_found');
    if (c.status !== 'ACTIVE') throw new Error('contract_not_active');
    return this.prisma.merchantContract.update({
      where: { id },
      data: { endDate: new Date(newEndDate), status: 'ACTIVE' },
    });
  }

  async getContractAnalytics(userId: string) {
    const all = await this.prisma.merchantContract.findMany({ where: { userId } });
    if (all.length === 0) {
      return { totalContracts: 0, analyticsLevel: 'no_data' as const };
    }
    const byStatus: Record<string, number> = {};
    let totalBilled = BigInt(0);
    let totalCycles = 0;
    for (const c of all) {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      totalBilled += c.totalBilled ?? BigInt(0);
      totalCycles += c.billingCycles;
    }
    return {
      totalContracts: all.length,
      byStatus,
      totalBilled: totalBilled.toString(),
      totalBillingCycles: totalCycles,
      analyticsLevel: 'full' as const,
    };
  }
}
