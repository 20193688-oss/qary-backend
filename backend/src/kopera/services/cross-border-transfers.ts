import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class CrossBorderTransferService {
  constructor(private prisma: PrismaClient) {}

  async initiateTransfer(userId: string, data: {
    sourceCurrency: string;
    targetCurrency: string;
    amount: bigint;
    recipientName: string;
    recipientCountry: string;
    recipientBankCode: string;
    recipientAccountNumber: string;
    purpose: string;
  }) {
    const fxRate = await this.getExchangeRate(data.sourceCurrency, data.targetCurrency);
    const convertedAmount = BigInt(Math.floor(Number(data.amount) * fxRate));
    const fee = BigInt(Math.max(Math.floor(Number(data.amount) * 0.005), 100));

    return this.prisma.crossBorderTransfer.create({
      data: {
        userId,
        sourceCurrency: data.sourceCurrency.toUpperCase(),
        targetCurrency: data.targetCurrency.toUpperCase(),
        sourceAmount: data.amount,
        targetAmount: convertedAmount,
        fxRate,
        fee,
        recipientName: data.recipientName,
        recipientCountry: data.recipientCountry.toUpperCase(),
        recipientBankCode: data.recipientBankCode,
        recipientAccountNumber: data.recipientAccountNumber,
        purpose: data.purpose,
        status: 'PROCESSING',
        reference: `XBR-${Date.now()}-${randomUUID().slice(0, 8)}`,
        initiatedAt: new Date(),
      },
    });
  }

  async getTransfers(userId: string) {
    return this.prisma.crossBorderTransfer.findMany({ where: { userId } });
  }

  async getTransfer(userId: string, id: string) {
    const transfer = await this.prisma.crossBorderTransfer.findUnique({ where: { id } });
    if (!transfer) throw new Error('transfer_not_found');
    if ((transfer as any).userId !== userId) throw new Error('transfer_not_found');
    return transfer;
  }

  async cancelTransfer(userId: string, id: string) {
    const transfer = await this.getTransfer(userId, id);
    if ((transfer as any).status !== 'PROCESSING') throw new Error('transfer_not_cancellable');
    return this.prisma.crossBorderTransfer.update({
      where: { id },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
  }

  async getExchangeRate(sourceCurrency: string, targetCurrency: string): Promise<number> {
    const rates: Record<string, number> = {
      'USD-EUR': 0.92, 'EUR-USD': 1.09,
      'USD-GBP': 0.79, 'GBP-USD': 1.27,
      'USD-COP': 4150.0, 'COP-USD': 0.00024,
      'EUR-GBP': 0.86, 'GBP-EUR': 1.16,
      'USD-MXN': 17.15, 'MXN-USD': 0.058,
      'USD-BRL': 4.97, 'BRL-USD': 0.201,
    };
    const key = `${sourceCurrency.toUpperCase()}-${targetCurrency.toUpperCase()}`;
    return rates[key] ?? 1.0;
  }

  async getQuote(sourceCurrency: string, targetCurrency: string, amount: bigint) {
    const fxRate = await this.getExchangeRate(sourceCurrency, targetCurrency);
    const convertedAmount = BigInt(Math.floor(Number(amount) * fxRate));
    const fee = BigInt(Math.max(Math.floor(Number(amount) * 0.005), 100));
    const totalCost = amount + fee;

    return {
      sourceCurrency: sourceCurrency.toUpperCase(),
      targetCurrency: targetCurrency.toUpperCase(),
      sourceAmount: amount.toString(),
      targetAmount: convertedAmount.toString(),
      fxRate,
      fee: fee.toString(),
      totalCost: totalCost.toString(),
      validUntil: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  async getTransferAnalytics(userId: string) {
    const transfers = await this.prisma.crossBorderTransfer.findMany({ where: { userId } });

    if (transfers.length === 0) {
      return {
        totalTransfers: 0,
        corridors: [],
        totalVolume: '0',
        totalFees: '0',
        avgTransferSize: '0',
        analyticsLevel: 'no_data',
      };
    }

    const completed = transfers.filter((t: any) => t.status === 'COMPLETED');
    const corridorMap: Record<string, { count: number; volume: bigint }> = {};

    for (const t of transfers as any[]) {
      const corridor = `${t.sourceCurrency}-${t.recipientCountry}`;
      if (!corridorMap[corridor]) corridorMap[corridor] = { count: 0, volume: BigInt(0) };
      corridorMap[corridor].count++;
      corridorMap[corridor].volume += t.sourceAmount as bigint;
    }

    const corridors = Object.entries(corridorMap).map(([name, data]) => ({
      corridor: name,
      count: data.count,
      volume: data.volume.toString(),
    }));

    const totalVolume = transfers.reduce((s: bigint, t: any) => s + (t.sourceAmount as bigint), BigInt(0));
    const totalFees = transfers.reduce((s: bigint, t: any) => s + (t.fee as bigint), BigInt(0));
    const avgTransferSize = BigInt(Math.floor(Number(totalVolume) / transfers.length));

    const successRate = transfers.length > 0
      ? completed.length / transfers.length
      : 0;

    let analyticsLevel: string;
    if (successRate >= 0.9) analyticsLevel = 'excellent';
    else if (successRate >= 0.7) analyticsLevel = 'good';
    else analyticsLevel = 'needs_improvement';

    return {
      totalTransfers: transfers.length,
      completedTransfers: completed.length,
      successRate: Math.round(successRate * 100),
      corridors,
      totalVolume: totalVolume.toString(),
      totalFees: totalFees.toString(),
      avgTransferSize: avgTransferSize.toString(),
      analyticsLevel,
    };
  }
}
