import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const FEE_RATES: Record<string, number> = {
  CARD: 0.029,
  APPLE_PAY: 0.029,
  GOOGLE_PAY: 0.029,
  BANK_TRANSFER: 0.005,
  ACH: 0.005,
  SEPA: 0.005,
  WALLET: 0.01,
  QR_CODE: 0.01,
  PIX: 0.008,
  SPEI: 0.008,
  UPI: 0.008,
  STABLECOIN: 0.003,
};
const FLAT_FEE_CENTS: Record<string, number> = {
  CARD: 30,
  APPLE_PAY: 30,
  GOOGLE_PAY: 30,
};

export function calculateGatewayFee(amountCents: bigint, paymentMethod: string): bigint {
  const rate = FEE_RATES[paymentMethod] ?? 0.029;
  const flat = FLAT_FEE_CENTS[paymentMethod] ?? 0;
  const percentageFee = Math.ceil(Number(amountCents) * rate);
  return BigInt(percentageFee + flat);
}

export class GatewayPaymentService {
  constructor(private prisma: PrismaClient) {}

  async getPaymentStats(userId: string) {
    const userTxns = await this.prisma.transaction.findMany({ where: { userId } });
    const txnIds = new Set(userTxns.map((t: any) => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany({});
    const payments = allPayments.filter((p: any) => txnIds.has(p.transactionId));

    let totalVolume = BigInt(0);
    let totalFees = BigInt(0);
    const byMethod: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const p of payments) {
      totalVolume += p.amount;
      totalFees += p.gatewayFee;
      byMethod[p.paymentMethod] = (byMethod[p.paymentMethod] ?? 0) + 1;
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    }

    return {
      totalPayments: payments.length,
      totalVolume,
      totalFees,
      avgTransactionSize: payments.length > 0 ? totalVolume / BigInt(payments.length) : BigInt(0),
      byMethod,
      byStatus,
    };
  }

  async findByIdempotencyKey(key: string) {
    return this.prisma.gatewayPayment.findUnique({ where: { idempotencyKey: key } });
  }

  async findById(id: string) {
    return this.prisma.gatewayPayment.findUnique({
      where: { id },
      include: { transaction: true },
    });
  }

  async listByUser(userId: string, opts: { limit?: number; offset?: number; status?: string } = {}) {
    return this.prisma.gatewayPayment.findMany({
      where: {
        transaction: { userId },
        ...(opts.status ? { status: opts.status as any } : {}),
      },
      take: Math.min(opts.limit ?? 20, 100),
      skip: opts.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createPayment(data: {
    userId: string;
    amount: bigint;
    currency: string;
    paymentMethod: string;
    description?: string;
    merchantId?: string;
    idempotencyKey: string;
    antifraudScore: number;
    antifraudDecision: string;
    antifraudDetails: object;
    metadata?: object;
  }) {
    const reference = `GW-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const isReview = data.antifraudDecision === 'REVIEW';

    const transaction = await this.prisma.transaction.create({
      data: {
        userId: data.userId,
        type: 'PAYMENT',
        status: isReview ? 'PROCESSING' : 'COMPLETED',
        amount: data.amount,
        currency: data.currency,
        description: data.description,
        reference,
        paymentMethodUsed: data.paymentMethod as any,
        metadata: (data.metadata ?? {}) as object,
        processedAt: isReview ? undefined : new Date(),
      },
    });

    const gatewayFee = calculateGatewayFee(data.amount, data.paymentMethod);

    const gatewayPayment = await this.prisma.gatewayPayment.create({
      data: {
        transactionId: transaction.id,
        merchantId: data.merchantId,
        status: isReview ? 'REQUIRES_ACTION' : 'CAPTURED',
        paymentMethod: data.paymentMethod as any,
        amount: data.amount,
        currency: data.currency,
        gatewayFee,
        antifraudScore: data.antifraudScore,
        antifraudDecision: data.antifraudDecision,
        antifraudDetails: data.antifraudDetails,
        idempotencyKey: data.idempotencyKey,
        threeDSecureStatus: data.paymentMethod === 'CARD' && Number(data.amount) > 10000 ? 'required' : 'not_required',
      },
    });

    return { transaction, gatewayPayment };
  }

  async capture(id: string) {
    const gp = await this.prisma.gatewayPayment.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!gp) throw new Error('not_found');
    if (gp.status !== 'REQUIRES_ACTION' && gp.status !== 'PROCESSING') {
      throw new Error('cannot_capture');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.gatewayPayment.update({
        where: { id },
        data: { status: 'CAPTURED' },
      });
      await tx.transaction.update({
        where: { id: gp.transactionId },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });
      return updated;
    });
  }

  async void(id: string) {
    const gp = await this.prisma.gatewayPayment.findUnique({ where: { id } });
    if (!gp) throw new Error('not_found');
    if (gp.status === 'SETTLED' || gp.status === 'REFUNDED' || gp.status === 'CANCELLED') {
      throw new Error('cannot_void');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.gatewayPayment.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      await tx.transaction.update({
        where: { id: gp.transactionId },
        data: { status: 'CANCELLED' },
      });
      return updated;
    });
  }

  async settle(id: string, settlementAmount?: bigint, settlementCurrency?: string) {
    const gp = await this.prisma.gatewayPayment.findUnique({ where: { id } });
    if (!gp) throw new Error('not_found');
    if (gp.status !== 'CAPTURED') throw new Error('cannot_settle');

    return this.prisma.gatewayPayment.update({
      where: { id },
      data: {
        status: 'SETTLED',
        settlementAmount: settlementAmount ?? gp.amount,
        settlementCurrency: settlementCurrency ?? gp.currency,
        settledAt: new Date(),
      },
    });
  }

  async markWebhookDelivered(id: string) {
    const gp = await this.prisma.gatewayPayment.findUnique({ where: { id } });
    if (!gp) throw new Error('not_found');
    if (gp.webhookDelivered) throw new Error('already_delivered');

    return this.prisma.gatewayPayment.update({
      where: { id },
      data: { webhookDelivered: true },
    });
  }

  async getPendingSettlements(userId: string) {
    const userTxns = await this.prisma.transaction.findMany({ where: { userId } });
    const txnIds = new Set(userTxns.map((t: any) => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany({});
    const captured = allPayments.filter((p: any) => txnIds.has(p.transactionId) && p.status === 'CAPTURED');

    let totalPending = BigInt(0);
    const items = captured.map((p: any) => {
      totalPending += p.amount;
      const ageMs = Date.now() - new Date(p.createdAt).getTime();
      return {
        id: p.id,
        transactionId: p.transactionId,
        amount: p.amount,
        currency: p.currency,
        paymentMethod: p.paymentMethod,
        capturedAt: p.createdAt,
        ageHours: Math.floor(ageMs / (1000 * 60 * 60)),
      };
    }).sort((a: any, b: any) => b.ageHours - a.ageHours);

    return { totalPending, count: items.length, items };
  }

  async getFeeAnalysis(userId: string) {
    const userTxns = await this.prisma.transaction.findMany({ where: { userId } });
    const txnIds = new Set(userTxns.map((t: any) => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany({});
    const payments = allPayments.filter((p: any) => txnIds.has(p.transactionId));

    const byMethod: Record<string, { count: number; totalAmount: bigint; totalFees: bigint; effectiveRate: number }> = {};
    let totalFees = BigInt(0);
    let totalVolume = BigInt(0);

    for (const p of payments) {
      const method = p.paymentMethod;
      if (!byMethod[method]) byMethod[method] = { count: 0, totalAmount: BigInt(0), totalFees: BigInt(0), effectiveRate: 0 };
      byMethod[method].count++;
      byMethod[method].totalAmount += p.amount;
      byMethod[method].totalFees += p.gatewayFee;
      totalFees += p.gatewayFee;
      totalVolume += p.amount;
    }

    for (const data of Object.values(byMethod)) {
      data.effectiveRate = data.totalAmount > BigInt(0)
        ? Math.round(Number(data.totalFees * BigInt(10000) / data.totalAmount)) / 100
        : 0;
    }

    const methods = Object.entries(byMethod).sort((a, b) => Number(a[1].totalFees - b[1].totalFees));
    const cheapestMethod = methods.length > 0 ? methods[0][0] : null;
    const mostExpensiveMethod = methods.length > 0 ? methods[methods.length - 1][0] : null;

    const overallEffectiveRate = totalVolume > BigInt(0)
      ? Math.round(Number(totalFees * BigInt(10000) / totalVolume)) / 100
      : 0;

    return {
      totalPayments: payments.length,
      totalVolume,
      totalFees,
      overallEffectiveRate,
      cheapestMethod,
      mostExpensiveMethod,
      byMethod,
    };
  }

  async getSettlementVelocity(userId: string) {
    const userTxns = await this.prisma.transaction.findMany({ where: { userId } });
    const txnIds = new Set(userTxns.map((t: any) => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany({});
    const payments = allPayments.filter((p: any) => txnIds.has(p.transactionId));

    const settled = payments.filter((p: any) => p.status === 'SETTLED' && p.settledAt);
    const unsettled = payments.filter((p: any) => p.status === 'CAPTURED');

    let totalSettlementMs = 0;
    const byMethod: Record<string, { count: number; totalMs: number; avgHours: number }> = {};

    for (const p of settled) {
      const ms = new Date(p.settledAt).getTime() - new Date(p.createdAt).getTime();
      totalSettlementMs += ms;

      if (!byMethod[p.paymentMethod]) byMethod[p.paymentMethod] = { count: 0, totalMs: 0, avgHours: 0 };
      byMethod[p.paymentMethod].count++;
      byMethod[p.paymentMethod].totalMs += ms;
    }

    for (const data of Object.values(byMethod)) {
      data.avgHours = data.count > 0 ? Math.round(data.totalMs / data.count / (1000 * 60 * 60) * 100) / 100 : 0;
    }

    const avgSettlementHours = settled.length > 0
      ? Math.round(totalSettlementMs / settled.length / (1000 * 60 * 60) * 100) / 100
      : 0;

    const methods = Object.entries(byMethod).sort((a, b) => a[1].avgHours - b[1].avgHours);
    const fastestMethod = methods.length > 0 ? methods[0][0] : null;
    const slowestMethod = methods.length > 0 ? methods[methods.length - 1][0] : null;

    return {
      totalPayments: payments.length,
      settledCount: settled.length,
      unsettledCount: unsettled.length,
      avgSettlementHours,
      fastestMethod,
      slowestMethod,
      byMethod,
    };
  }

  async refund(id: string, refundAmount?: bigint, reason?: string) {
    const gp = await this.prisma.gatewayPayment.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!gp) throw new Error('not_found');
    if (gp.status !== 'CAPTURED' && gp.status !== 'SETTLED') {
      throw new Error('cannot_refund_status');
    }

    const amount = refundAmount ?? gp.amount;

    return this.prisma.$transaction(async (tx) => {
      await tx.gatewayPayment.update({
        where: { id },
        data: { status: 'REFUNDED' },
      });
      await tx.transaction.update({
        where: { id: gp.transactionId },
        data: { status: 'REVERSED' },
      });
      const refundTxn = await tx.transaction.create({
        data: {
          userId: gp.transaction.userId,
          type: 'REFUND',
          status: 'COMPLETED',
          amount,
          currency: gp.currency,
          description: reason ?? 'Refund',
          reference: `REF-${Date.now()}-${randomUUID().slice(0, 8)}`,
          reversalOf: gp.transactionId,
          processedAt: new Date(),
        },
      });
      return { gatewayPayment: gp, refundTransaction: refundTxn, amount };
    });
  }
}
