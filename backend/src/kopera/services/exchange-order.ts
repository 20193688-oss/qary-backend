import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class ExchangeOrderService {
  constructor(private prisma: PrismaClient) {}

  async createOrder(userId: string, data: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount: bigint;
    exchangeRate: number;
    orderType: string;
  }) {
    const toAmount = BigInt(Math.round(Number(data.fromAmount) * data.exchangeRate));

    return this.prisma.exchangeOrder.create({
      data: {
        userId,
        fromCurrency: data.fromCurrency.toUpperCase(),
        toCurrency: data.toCurrency.toUpperCase(),
        fromAmount: data.fromAmount,
        toAmount,
        exchangeRate: data.exchangeRate,
        orderType: data.orderType.toUpperCase(),
        status: 'PENDING',
        reference: `EXO-${Date.now()}-${randomUUID().slice(0, 8)}`,
        placedAt: new Date(),
      },
    });
  }

  async getOrders(userId: string) {
    return this.prisma.exchangeOrder.findMany({ where: { userId } });
  }

  async getOrder(userId: string, id: string) {
    const order = await this.prisma.exchangeOrder.findUnique({ where: { id } });
    if (!order) throw new Error('order_not_found');
    if ((order as any).userId !== userId) throw new Error('order_not_found');
    return order;
  }

  async executeOrder(userId: string, id: string) {
    const order = await this.getOrder(userId, id);
    if ((order as any).status !== 'PENDING') throw new Error('order_not_pending');

    return this.prisma.exchangeOrder.update({
      where: { id },
      data: { status: 'EXECUTED', executedAt: new Date() },
    });
  }

  async cancelOrder(userId: string, id: string) {
    const order = await this.getOrder(userId, id);
    if ((order as any).status !== 'PENDING') throw new Error('order_not_pending');

    return this.prisma.exchangeOrder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getOrdersByPair(userId: string, fromCurrency: string, toCurrency: string) {
    const orders = await this.prisma.exchangeOrder.findMany({ where: { userId } });
    return (orders as any[]).filter(
      (o) => o.fromCurrency === fromCurrency.toUpperCase() && o.toCurrency === toCurrency.toUpperCase(),
    );
  }

  async getExchangeAnalytics(userId: string) {
    const orders = await this.prisma.exchangeOrder.findMany({ where: { userId } });

    if (orders.length === 0) {
      return {
        totalOrders: 0,
        breakdown: { PENDING: 0, EXECUTED: 0, CANCELLED: 0 },
        totalVolume: '0',
        currencyPairs: [],
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { PENDING: 0, EXECUTED: 0, CANCELLED: 0 };
    let totalVolume = BigInt(0);
    const pairs = new Set<string>();
    for (const o of orders as any[]) {
      const status = o.status as string;
      if (status in breakdown) breakdown[status]++;
      totalVolume += o.fromAmount as bigint;
      pairs.add(`${o.fromCurrency}/${o.toCurrency}`);
    }

    return {
      totalOrders: orders.length,
      breakdown,
      totalVolume: totalVolume.toString(),
      currencyPairs: [...pairs],
      analyticsLevel: orders.length >= 5 ? 'sufficient' : 'limited',
    };
  }
}
