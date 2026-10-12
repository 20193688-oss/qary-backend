import type { PrismaClient } from '@prisma/client';

const INTERVAL_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  biweekly: 14 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export class ScheduledTransferService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    toUserId: string;
    currency: string;
    amount: bigint;
    frequency: string;
    description?: string;
    startDate?: Date;
  }) {
    if (params.userId === params.toUserId) throw new Error('cannot_transfer_to_self');

    const frequency = params.frequency.toLowerCase();
    if (frequency !== 'once' && !INTERVAL_MS[frequency]) throw new Error('invalid_frequency');

    const recipient = await this.prisma.user.findUnique({ where: { id: params.toUserId } });
    if (!recipient) throw new Error('recipient_not_found');

    const now = new Date();
    const nextExecution = params.startDate && params.startDate > now ? params.startDate : now;

    return this.prisma.scheduledTransfer.create({
      data: {
        userId: params.userId,
        toUserId: params.toUserId,
        currency: params.currency.toUpperCase(),
        amount: params.amount,
        frequency,
        description: params.description ?? 'Scheduled transfer',
        status: 'active',
        nextExecutionDate: nextExecution,
        lastExecutionDate: null,
        executionCount: 0,
      },
    });
  }

  async listByUser(userId: string) {
    return this.prisma.scheduledTransfer.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    return this.prisma.scheduledTransfer.findUnique({ where: { id } });
  }

  async cancel(id: string, userId: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');
    if (st.userId !== userId) throw new Error('forbidden');
    if (st.status === 'cancelled') throw new Error('already_cancelled');

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }

  async pause(id: string, userId: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');
    if (st.userId !== userId) throw new Error('forbidden');
    if (st.status !== 'active') throw new Error('not_active');

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: { status: 'paused' },
    });
  }

  async resume(id: string, userId: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');
    if (st.userId !== userId) throw new Error('forbidden');
    if (st.status !== 'paused') throw new Error('not_paused');

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: { status: 'active' },
    });
  }

  async markExecuted(id: string) {
    const st = await this.prisma.scheduledTransfer.findUnique({ where: { id } });
    if (!st) throw new Error('scheduled_transfer_not_found');

    const nextDate = st.frequency === 'once'
      ? null
      : new Date(Date.now() + (INTERVAL_MS[st.frequency] ?? 0));

    return this.prisma.scheduledTransfer.update({
      where: { id },
      data: {
        executionCount: st.executionCount + 1,
        lastExecutionDate: new Date(),
        nextExecutionDate: nextDate,
        status: st.frequency === 'once' ? 'completed' : st.status,
      },
    });
  }

  async processDueTransfers() {
    const now = new Date();
    const due = await this.prisma.scheduledTransfer.findMany({
      where: { status: 'active', nextExecutionDate: { lte: now } },
    });

    const results: Array<{ transferId: string; success: boolean; reason?: string }> = [];

    for (const st of due) {
      const senderWallet = await this.prisma.wallet.findFirst({
        where: { userId: st.userId, currency: st.currency, status: 'ACTIVE' },
      });

      if (!senderWallet || senderWallet.balance < st.amount) {
        results.push({ transferId: st.id, success: false, reason: 'insufficient_funds' });
        continue;
      }

      let receiverWallet = await this.prisma.wallet.findFirst({
        where: { userId: st.toUserId, currency: st.currency, status: 'ACTIVE' },
      });

      if (!receiverWallet) {
        receiverWallet = await this.prisma.wallet.create({
          data: {
            userId: st.toUserId,
            currency: st.currency,
            balance: BigInt(0),
            status: 'ACTIVE',
            isDefault: false,
          },
        });
      }

      await this.prisma.wallet.update({
        where: { id: senderWallet.id },
        data: { balance: senderWallet.balance - st.amount },
      });

      await this.prisma.wallet.update({
        where: { id: receiverWallet.id },
        data: { balance: receiverWallet.balance + st.amount },
      });

      await this.markExecuted(st.id);

      results.push({ transferId: st.id, success: true });
    }

    return { processed: results.length, results };
  }
}
