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
