import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

export async function registerDashboardRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get('/api/dashboard', { preHandler: [app.requireAuth] }, async (req) => {
    const userId = req.auth!.userId;

    const [
      wallets,
      recentTransactions,
      unreadNotifications,
      activeGoals,
      activeSubscriptions,
      pendingPayments,
      activeLimits,
    ] = await Promise.all([
      prisma.wallet.findMany({ where: { userId } }),
      prisma.transaction.findMany({
        where: { userId },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
      prisma.savingsGoal.findMany({ where: { userId, status: 'active' } }),
      prisma.subscription.findMany({ where: { userId, status: 'active' } }),
      prisma.gatewayPayment.findMany({
        where: { status: { in: ['CREATED', 'REQUIRES_ACTION', 'PROCESSING'] } },
      }),
      prisma.transactionLimit.findMany({ where: { userId } }),
    ]);

    const userPendingPayments = pendingPayments.filter((gp: any) => {
      const txn = recentTransactions.find((t: any) => t.id === gp.transactionId);
      return txn?.userId === userId;
    });

    return {
      wallets: wallets.map((w: any) => ({
        id: w.id,
        currency: w.currency,
        balance: w.balance.toString(),
        status: w.status,
        isDefault: w.isDefault,
      })),
      totalBalance: wallets
        .filter((w: any) => w.status === 'ACTIVE')
        .reduce((acc: Record<string, string>, w: any) => {
          acc[w.currency] = (BigInt(acc[w.currency] ?? '0') + w.balance).toString();
          return acc;
        }, {} as Record<string, string>),
      recentTransactions: recentTransactions.map((t: any) => ({
        id: t.id,
        type: t.type,
        status: t.status,
        amount: t.amount.toString(),
        currency: t.currency,
        description: t.description,
        createdAt: t.createdAt,
      })),
      unreadNotifications,
      activeGoals: activeGoals.map((g: any) => ({
        id: g.id,
        name: g.name,
        targetAmount: g.targetAmount.toString(),
        currentAmount: g.currentAmount.toString(),
        currency: g.currency,
        progress: Number(g.currentAmount) / Number(g.targetAmount) * 100,
        deadline: g.deadline,
      })),
      activeSubscriptions: activeSubscriptions.map((s: any) => ({
        id: s.id,
        planName: s.planName,
        amount: s.amount.toString(),
        currency: s.currency,
        interval: s.interval,
        nextBillingDate: s.nextBillingDate,
      })),
      pendingPayments: userPendingPayments.length,
      transactionLimits: activeLimits.map((l: any) => ({
        currency: l.currency,
        limitType: l.limitType,
        maxAmount: l.maxAmount.toString(),
        currentUsage: l.currentUsage.toString(),
        remaining: (l.maxAmount - l.currentUsage).toString(),
      })),
    };
  });

  app.get('/api/gateway/payments/:id/receipt', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const gp = await prisma.gatewayPayment.findUnique({
      where: { id },
    });
    if (!gp) return reply.code(404).send({ error: 'not_found' });

    const txn = await prisma.transaction.findUnique({ where: { id: gp.transactionId } });
    if (!txn) return reply.code(404).send({ error: 'not_found' });
    if (txn.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });

    if (gp.status !== 'CAPTURED' && gp.status !== 'SETTLED') {
      return reply.code(400).send({ error: 'receipt_not_available', reason: 'Payment not yet completed' });
    }

    const user = await prisma.user.findUnique({ where: { id: txn.userId } });

    return {
      receiptId: `RCP-${gp.id.slice(0, 8).toUpperCase()}`,
      paymentId: gp.id,
      transactionId: gp.transactionId,
      status: gp.status,
      paymentMethod: gp.paymentMethod,
      amount: gp.amount.toString(),
      currency: gp.currency,
      gatewayFee: gp.gatewayFee.toString(),
      netAmount: (gp.amount - gp.gatewayFee).toString(),
      cardLast4: gp.cardLast4,
      cardNetwork: gp.cardNetwork,
      merchantId: gp.merchantId,
      description: txn.description,
      reference: txn.reference,
      paidBy: user ? { email: user.email, name: user.name } : null,
      paidAt: txn.processedAt ?? txn.createdAt,
      settlementAmount: gp.settlementAmount?.toString() ?? null,
      settlementCurrency: gp.settlementCurrency ?? null,
      settledAt: gp.settledAt ?? null,
      issuedAt: new Date().toISOString(),
    };
  });

  app.delete('/api/notifications/read', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const userId = req.auth!.userId;
    const result = await prisma.notification.deleteMany({
      where: { userId, readAt: { not: null } },
    });
    return reply.send({ deleted: result.count });
  });
}
