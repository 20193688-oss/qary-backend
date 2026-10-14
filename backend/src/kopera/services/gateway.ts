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

  async getRevenueAnalysis(userId: string) {
    const payments = await this.prisma.gatewayPayment.findMany({
      where: { transaction: { userId } },
    });

    if (payments.length === 0) {
      return {
        totalPayments: 0,
        totalProcessed: '0',
        totalFees: '0',
        netRevenue: '0',
        refundedAmount: '0',
        byMethod: {} as Record<string, { count: number; processed: string; fees: string }>,
        byStatus: {} as Record<string, number>,
      };
    }

    let totalProcessed = BigInt(0);
    let totalFees = BigInt(0);
    let refundedAmount = BigInt(0);
    const byMethod: Record<string, { count: number; processed: bigint; fees: bigint }> = {};
    const byStatus: Record<string, number> = {};

    for (const p of payments) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      totalProcessed += p.amount;
      totalFees += p.gatewayFee;
      if (p.status === 'REFUNDED') refundedAmount += p.amount;

      const method = p.paymentMethod;
      if (!byMethod[method]) byMethod[method] = { count: 0, processed: BigInt(0), fees: BigInt(0) };
      byMethod[method].count++;
      byMethod[method].processed += p.amount;
      byMethod[method].fees += p.gatewayFee;
    }

    const serializedByMethod: Record<string, { count: number; processed: string; fees: string }> = {};
    for (const [m, d] of Object.entries(byMethod)) {
      serializedByMethod[m] = { count: d.count, processed: d.processed.toString(), fees: d.fees.toString() };
    }

    return {
      totalPayments: payments.length,
      totalProcessed: totalProcessed.toString(),
      totalFees: totalFees.toString(),
      netRevenue: (totalProcessed - totalFees - refundedAmount).toString(),
      refundedAmount: refundedAmount.toString(),
      byMethod: serializedByMethod,
      byStatus,
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

  async getPaymentMethodTrends(userId: string) {
    const userTxns = await this.prisma.transaction.findMany({ where: { userId } });
    const txnIds = new Set(userTxns.map((t: any) => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany({});
    const payments = allPayments
      .filter((p: any) => txnIds.has(p.transactionId))
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (payments.length === 0) {
      return {
        totalPayments: 0,
        monthlyTrends: [],
        methodShares: [],
        fastestGrowing: null,
        diversityIndex: 0,
      };
    }

    const monthMap = new Map<string, Map<string, { count: number; volume: bigint }>>();
    const methodTotals = new Map<string, { count: number; volume: bigint }>();

    for (const p of payments) {
      const method = p.paymentMethod ?? 'unknown';
      const d = new Date(p.createdAt);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

      if (!monthMap.has(monthKey)) monthMap.set(monthKey, new Map());
      const methodMap = monthMap.get(monthKey)!;
      const mEntry = methodMap.get(method) ?? { count: 0, volume: BigInt(0) };
      mEntry.count++;
      mEntry.volume += p.amount;
      methodMap.set(method, mEntry);

      const tEntry = methodTotals.get(method) ?? { count: 0, volume: BigInt(0) };
      tEntry.count++;
      tEntry.volume += p.amount;
      methodTotals.set(method, tEntry);
    }

    const monthlyTrends = Array.from(monthMap.entries())
      .map(([month, methods]) => ({
        month,
        methods: Array.from(methods.entries()).map(([method, data]) => ({
          method,
          count: data.count,
          volume: data.volume.toString(),
        })),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const methodShares = Array.from(methodTotals.entries())
      .map(([method, data]) => ({
        method,
        count: data.count,
        volume: data.volume.toString(),
        share: Math.round((data.count / payments.length) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    const shares = methodShares.map((m) => m.share / 100);
    const diversityIndex = shares.length > 1
      ? Math.round((1 - shares.reduce((s, p) => s + p * p, 0)) * 10000) / 100
      : 0;

    let fastestGrowing: string | null = null;
    if (monthlyTrends.length >= 2) {
      const first = monthlyTrends[0];
      const last = monthlyTrends[monthlyTrends.length - 1];
      let bestGrowth = -Infinity;
      for (const m of methodShares) {
        const firstCount = first.methods.find((x) => x.method === m.method)?.count ?? 0;
        const lastCount = last.methods.find((x) => x.method === m.method)?.count ?? 0;
        const growth = lastCount - firstCount;
        if (growth > bestGrowth) {
          bestGrowth = growth;
          fastestGrowing = m.method;
        }
      }
    }

    return {
      totalPayments: payments.length,
      monthlyTrends,
      methodShares,
      fastestGrowing,
      diversityIndex,
    };
  }

  async getFailureAnalysis(userId: string) {
    const userTxns = await this.prisma.transaction.findMany({ where: { userId } });
    const txnIds = new Set(userTxns.map((t: any) => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany({});
    const payments = allPayments.filter((p: any) => txnIds.has(p.transactionId));

    if (payments.length === 0) {
      return {
        totalPayments: 0,
        failedCount: 0,
        failureRate: 0,
        byReason: [],
        byMethod: [],
        recentFailures: [],
        trend: 'none' as const,
      };
    }

    const failed = payments.filter((p: any) => p.status === 'FAILED');
    const failureRate = Math.round((failed.length / payments.length) * 10000) / 100;

    const reasonMap = new Map<string, number>();
    for (const p of failed) {
      const reason = (p as any).failureReason ?? (p as any).errorCode ?? 'unknown';
      reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
    }

    const byReason = Array.from(reasonMap.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percent: failed.length > 0 ? Math.round((count / failed.length) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const methodFailMap = new Map<string, { total: number; failed: number }>();
    for (const p of payments) {
      const method = (p as any).paymentMethod ?? 'unknown';
      const entry = methodFailMap.get(method) ?? { total: 0, failed: 0 };
      entry.total++;
      if ((p as any).status === 'FAILED') entry.failed++;
      methodFailMap.set(method, entry);
    }

    const byMethod = Array.from(methodFailMap.entries())
      .map(([method, data]) => ({
        method,
        total: data.total,
        failed: data.failed,
        failureRate: data.total > 0 ? Math.round((data.failed / data.total) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.failureRate - a.failureRate);

    const recentFailures = failed
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map((p: any) => ({
        id: p.id,
        amount: p.amount.toString(),
        method: p.paymentMethod ?? 'unknown',
        reason: p.failureReason ?? p.errorCode ?? 'unknown',
        createdAt: p.createdAt,
      }));

    const sorted = payments.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const half = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, half);
    const secondHalf = sorted.slice(half);
    const firstRate = firstHalf.length > 0 ? firstHalf.filter((p: any) => p.status === 'FAILED').length / firstHalf.length : 0;
    const secondRate = secondHalf.length > 0 ? secondHalf.filter((p: any) => p.status === 'FAILED').length / secondHalf.length : 0;

    let trend: 'improving' | 'worsening' | 'stable' | 'none' = 'stable';
    if (secondRate < firstRate * 0.8) trend = 'improving';
    else if (secondRate > firstRate * 1.2) trend = 'worsening';

    return {
      totalPayments: payments.length,
      failedCount: failed.length,
      failureRate,
      byReason,
      byMethod,
      recentFailures,
      trend,
    };
  }

  async getProviderPerformanceBenchmark(userId: string) {
    const payments = await this.prisma.gatewayPayment.findMany({ where: { userId } });
    if (payments.length === 0) {
      return {
        totalPayments: 0,
        providers: [],
        bestProvider: null,
        worstProvider: null,
      };
    }

    const providerMap = new Map<string, { total: number; successful: number; failed: number; totalAmount: bigint; processingTimes: number[] }>();

    for (const p of payments) {
      const provider = (p as any).provider || (p as any).gateway || 'unknown';
      if (!providerMap.has(provider)) {
        providerMap.set(provider, { total: 0, successful: 0, failed: 0, totalAmount: BigInt(0), processingTimes: [] });
      }
      const entry = providerMap.get(provider)!;
      entry.total++;
      entry.totalAmount += (p as any).amount ?? BigInt(0);

      if ((p as any).status === 'completed' || (p as any).status === 'success' || (p as any).status === 'succeeded') {
        entry.successful++;
      } else if ((p as any).status === 'failed' || (p as any).status === 'error') {
        entry.failed++;
      }

      if ((p as any).processedAt) {
        const processingMs = new Date((p as any).processedAt).getTime() - new Date(p.createdAt).getTime();
        if (processingMs > 0) entry.processingTimes.push(processingMs);
      }
    }

    const providers = Array.from(providerMap.entries())
      .map(([provider, data]) => {
        const successRate = data.total > 0 ? Math.round((data.successful / data.total) * 10000) / 100 : 0;
        const avgProcessingMs = data.processingTimes.length > 0
          ? Math.round(data.processingTimes.reduce((s, t) => s + t, 0) / data.processingTimes.length)
          : null;
        return {
          provider,
          totalPayments: data.total,
          successRate,
          failureCount: data.failed,
          totalVolume: data.totalAmount.toString(),
          avgProcessingMs,
          score: Math.round(successRate - (data.failed * 2)),
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      totalPayments: payments.length,
      providers,
      bestProvider: providers.length > 0 ? providers[0].provider : null,
      worstProvider: providers.length > 1 ? providers[providers.length - 1].provider : null,
    };
  }

  async getPaymentConversionFunnel(userId: string) {
    const txns = await this.prisma.transaction.findMany({ where: { userId } });
    const txnIds = new Set(txns.map(t => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany({});
    const payments = allPayments.filter((p: any) => txnIds.has(p.transactionId));

    if (payments.length === 0) {
      return {
        totalPayments: 0,
        initiated: 0,
        authorized: 0,
        captured: 0,
        settled: 0,
        failed: 0,
        voided: 0,
        conversionRate: 0,
        dropoffStage: null,
      };
    }

    let initiated = 0, authorized = 0, captured = 0, settled = 0, failed = 0, voided = 0;

    for (const p of payments) {
      const status = ((p as any).status || '').toLowerCase();
      initiated++;
      if (status === 'authorized' || status === 'captured' || status === 'settled') authorized++;
      if (status === 'captured' || status === 'settled') captured++;
      if (status === 'settled') settled++;
      if (status === 'failed') failed++;
      if (status === 'voided') voided++;
    }

    const conversionRate = Math.round((settled / initiated) * 10000) / 100;

    let dropoffStage: string | null = null;
    const stages = [
      { name: 'authorization', from: initiated, to: authorized },
      { name: 'capture', from: authorized, to: captured },
      { name: 'settlement', from: captured, to: settled },
    ];
    let maxDrop = 0;
    for (const s of stages) {
      if (s.from > 0) {
        const drop = s.from - s.to;
        if (drop > maxDrop) {
          maxDrop = drop;
          dropoffStage = s.name;
        }
      }
    }

    return {
      totalPayments: payments.length,
      initiated,
      authorized,
      captured,
      settled,
      failed,
      voided,
      conversionRate,
      dropoffStage,
    };
  }

  async getGatewayReconciliationStatus(userId: string) {
    const transactions = await this.prisma.transaction.findMany({ where: { userId } });
    if (transactions.length === 0) {
      return {
        totalTransactions: 0,
        reconciledCount: 0,
        unreconciledCount: 0,
        reconciliationRate: 100,
        statusBreakdown: [],
        healthLevel: 'no_data',
        recommendations: [],
      };
    }

    const txnIds = new Set(transactions.map(t => t.id));
    const allPayments = await this.prisma.gatewayPayment.findMany();
    const payments = allPayments.filter(p => txnIds.has((p as any).transactionId));

    const txnWithPayment = new Set(payments.map(p => (p as any).transactionId));
    const reconciledCount = transactions.filter(t => txnWithPayment.has(t.id)).length;
    const unreconciledCount = transactions.length - reconciledCount;
    const reconciliationRate = Math.round((reconciledCount / transactions.length) * 10000) / 100;

    const statusCounts: Record<string, number> = {};
    for (const p of payments) {
      const status = ((p as any).status || 'unknown').toLowerCase();
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    const statusBreakdown = Object.entries(statusCounts)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    const healthLevel = reconciliationRate >= 95 ? 'excellent'
      : reconciliationRate >= 80 ? 'good'
      : reconciliationRate >= 50 ? 'fair' : 'poor';

    const recommendations: string[] = [];
    if (unreconciledCount > 0) recommendations.push('Investigate unreconciled transactions for missing gateway payments');
    if (statusCounts['failed'] && statusCounts['failed'] > payments.length * 0.1) {
      recommendations.push('High failure rate detected — review gateway provider configuration');
    }
    if (reconciliationRate < 80) recommendations.push('Improve reconciliation by automating payment matching');

    return {
      totalTransactions: transactions.length,
      reconciledCount,
      unreconciledCount,
      reconciliationRate,
      statusBreakdown,
      healthLevel,
      recommendations,
    };
  }
}
