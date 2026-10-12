import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class WalletService {
  constructor(private prisma: PrismaClient) {}

  async createWallet(userId: string, currency: string, isDefault = false) {
    return this.prisma.wallet.create({
      data: { userId, currency: currency.toUpperCase(), isDefault },
    });
  }

  async getWallets(userId: string) {
    return this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getWallet(userId: string, currency: string) {
    return this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency: currency.toUpperCase() } },
    });
  }

  async getOrCreateWallet(userId: string, currency: string) {
    const existing = await this.getWallet(userId, currency);
    if (existing) return existing;
    const hasAny = await this.prisma.wallet.count({ where: { userId } });
    return this.createWallet(userId, currency, hasAny === 0);
  }

  async deposit(userId: string, currency: string, amount: bigint, description?: string) {
    const wallet = await this.getOrCreateWallet(userId, currency);
    if (wallet.status !== 'ACTIVE') throw new Error('wallet_frozen');

    const reference = `DEP-${Date.now()}-${randomUUID().slice(0, 8)}`;

    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.create({
        data: {
          userId,
          type: 'DEPOSIT',
          status: 'COMPLETED',
          amount,
          currency: currency.toUpperCase(),
          description: description ?? 'Deposit',
          reference,
          receiverWalletId: wallet.id,
          processedAt: new Date(),
        },
      });

      const balanceBefore = wallet.balance;
      const balanceAfter = balanceBefore + amount;

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId: txn.id,
          amount,
          balanceBefore,
          balanceAfter,
          entryType: 'CREDIT',
          description: description ?? 'Deposit',
        },
      });

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: balanceAfter,
          availableBalance: balanceAfter - wallet.holdBalance,
        },
      });

      return { transaction: txn, wallet: updated };
    });
  }

  async withdraw(userId: string, currency: string, amount: bigint, description?: string) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');
    if (wallet.status !== 'ACTIVE') throw new Error('wallet_frozen');
    if (wallet.availableBalance < amount) throw new Error('insufficient_funds');

    const reference = `WDR-${Date.now()}-${randomUUID().slice(0, 8)}`;

    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.create({
        data: {
          userId,
          type: 'WITHDRAWAL',
          status: 'COMPLETED',
          amount,
          currency: currency.toUpperCase(),
          description: description ?? 'Withdrawal',
          reference,
          senderWalletId: wallet.id,
          processedAt: new Date(),
        },
      });

      const balanceBefore = wallet.balance;
      const balanceAfter = balanceBefore - amount;

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId: txn.id,
          amount: -amount,
          balanceBefore,
          balanceAfter,
          entryType: 'DEBIT',
          description: description ?? 'Withdrawal',
        },
      });

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: balanceAfter,
          availableBalance: balanceAfter - wallet.holdBalance,
        },
      });

      return { transaction: txn, wallet: updated };
    });
  }

  async transfer(
    fromUserId: string,
    toUserId: string,
    currency: string,
    amount: bigint,
    description?: string,
  ) {
    const fromWallet = await this.getWallet(fromUserId, currency);
    if (!fromWallet) throw new Error('sender_wallet_not_found');
    if (fromWallet.status !== 'ACTIVE') throw new Error('sender_wallet_frozen');
    if (fromWallet.availableBalance < amount) throw new Error('insufficient_funds');

    const toWallet = await this.getOrCreateWallet(toUserId, currency);
    if (toWallet.status !== 'ACTIVE') throw new Error('receiver_wallet_frozen');

    const reference = `TRF-${Date.now()}-${randomUUID().slice(0, 8)}`;

    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.create({
        data: {
          userId: fromUserId,
          type: 'TRANSFER',
          status: 'COMPLETED',
          amount,
          currency: currency.toUpperCase(),
          description: description ?? 'Transfer',
          reference,
          senderWalletId: fromWallet.id,
          receiverWalletId: toWallet.id,
          processedAt: new Date(),
        },
      });

      // Debit sender
      await tx.ledgerEntry.create({
        data: {
          walletId: fromWallet.id,
          transactionId: txn.id,
          amount: -amount,
          balanceBefore: fromWallet.balance,
          balanceAfter: fromWallet.balance - amount,
          entryType: 'DEBIT',
          description: `Transfer to ${toUserId}`,
        },
      });

      await tx.wallet.update({
        where: { id: fromWallet.id },
        data: {
          balance: fromWallet.balance - amount,
          availableBalance: fromWallet.availableBalance - amount,
        },
      });

      // Credit receiver
      await tx.ledgerEntry.create({
        data: {
          walletId: toWallet.id,
          transactionId: txn.id,
          amount,
          balanceBefore: toWallet.balance,
          balanceAfter: toWallet.balance + amount,
          entryType: 'CREDIT',
          description: `Transfer from ${fromUserId}`,
        },
      });

      await tx.wallet.update({
        where: { id: toWallet.id },
        data: {
          balance: toWallet.balance + amount,
          availableBalance: toWallet.availableBalance + amount,
        },
      });

      return { transaction: txn };
    });
  }

  async getBalance(userId: string, currency: string) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) return null;
    return {
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      available: wallet.availableBalance.toString(),
      hold: wallet.holdBalance.toString(),
      status: wallet.status,
    };
  }

  async getAllBalances(userId: string) {
    const wallets = await this.getWallets(userId);
    return wallets.map((w) => ({
      currency: w.currency,
      balance: w.balance.toString(),
      available: w.availableBalance.toString(),
      hold: w.holdBalance.toString(),
      status: w.status,
      isDefault: w.isDefault,
    }));
  }

  async getPortfolio(userId: string) {
    const wallets = await this.getWallets(userId);
    const byStatus: Record<string, number> = {};
    const balanceByCurrency: Record<string, bigint> = {};
    let totalHold = BigInt(0);

    for (const w of wallets) {
      byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
      if (w.status === 'ACTIVE') {
        balanceByCurrency[w.currency] = (balanceByCurrency[w.currency] ?? BigInt(0)) + w.balance;
      }
      totalHold += w.holdBalance;
    }

    return {
      totalWallets: wallets.length,
      byStatus,
      balanceByCurrency,
      totalHold,
      currencies: Object.keys(balanceByCurrency),
    };
  }

  async getCashFlowReport(userId: string) {
    const txns = await this.prisma.transaction.findMany({ where: { userId, status: 'COMPLETED' } });

    const byCurrency: Record<string, { inflow: bigint; outflow: bigint; net: bigint; count: number }> = {};

    for (const t of txns) {
      if (!byCurrency[t.currency]) {
        byCurrency[t.currency] = { inflow: BigInt(0), outflow: BigInt(0), net: BigInt(0), count: 0 };
      }
      const entry = byCurrency[t.currency];
      entry.count++;

      if (t.type === 'DEPOSIT' || (t.type === 'TRANSFER' && (t as any).receiverWalletId)) {
        entry.inflow += t.amount;
      }
      if (t.type === 'WITHDRAWAL' || (t.type === 'TRANSFER' && (t as any).senderWalletId)) {
        entry.outflow += t.amount;
      }
    }

    for (const entry of Object.values(byCurrency)) {
      entry.net = entry.inflow - entry.outflow;
    }

    const totalTransactions = txns.length;
    const byType: Record<string, number> = {};
    for (const t of txns) {
      byType[t.type] = (byType[t.type] ?? 0) + 1;
    }

    return { totalTransactions, byCurrency, byType };
  }

  async freeze(userId: string, currency: string) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');
    if (wallet.status === 'FROZEN') throw new Error('already_frozen');
    if (wallet.status === 'CLOSED') throw new Error('wallet_closed');

    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { status: 'FROZEN' },
    });
  }

  async unfreeze(userId: string, currency: string) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');
    if (wallet.status !== 'FROZEN') throw new Error('not_frozen');

    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { status: 'ACTIVE' },
    });
  }

  async close(userId: string, currency: string) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');
    if (wallet.status === 'CLOSED') throw new Error('already_closed');
    if (wallet.balance > BigInt(0)) throw new Error('balance_not_zero');

    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { status: 'CLOSED' },
    });
  }

  async hold(userId: string, currency: string, amount: bigint) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');
    if (wallet.availableBalance < amount) throw new Error('insufficient_available');

    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        holdBalance: wallet.holdBalance + amount,
        availableBalance: wallet.availableBalance - amount,
      },
    });
  }

  async releaseHold(userId: string, currency: string, amount: bigint) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');
    if (wallet.holdBalance < amount) throw new Error('hold_exceeds_balance');

    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        holdBalance: wallet.holdBalance - amount,
        availableBalance: wallet.availableBalance + amount,
      },
    });
  }

  async renameWallet(userId: string, currency: string, label: string) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');

    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { label } as any,
    });
  }

  async getActivitySummary(userId: string) {
    const userWallets = await this.getWallets(userId);
    const txns = await this.prisma.transaction.findMany({ where: { userId } });

    const byWallet: Record<string, { currency: string; deposits: number; withdrawals: number; transfers: number; depositVolume: bigint; withdrawalVolume: bigint; transferVolume: bigint; lastActivityAt: Date | null }> = {};

    for (const w of userWallets) {
      byWallet[w.id] = {
        currency: w.currency,
        deposits: 0, withdrawals: 0, transfers: 0,
        depositVolume: BigInt(0), withdrawalVolume: BigInt(0), transferVolume: BigInt(0),
        lastActivityAt: null,
      };
    }

    for (const t of txns) {
      const wId = (t as any).senderWalletId ?? (t as any).receiverWalletId;
      if (!wId || !byWallet[wId]) continue;
      const entry = byWallet[wId];
      if (t.type === 'DEPOSIT') { entry.deposits++; entry.depositVolume += t.amount; }
      else if (t.type === 'WITHDRAWAL') { entry.withdrawals++; entry.withdrawalVolume += t.amount; }
      else if (t.type === 'TRANSFER') { entry.transfers++; entry.transferVolume += t.amount; }
      const txDate = t.processedAt ?? t.createdAt;
      if (!entry.lastActivityAt || txDate > entry.lastActivityAt) entry.lastActivityAt = txDate;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dormantWallets = Object.entries(byWallet)
      .filter(([, v]) => !v.lastActivityAt || v.lastActivityAt < thirtyDaysAgo)
      .map(([id, v]) => ({ walletId: id, currency: v.currency }));

    return { walletCount: userWallets.length, byWallet, dormantWallets };
  }

  async setDefault(userId: string, currency: string) {
    const wallet = await this.getWallet(userId, currency);
    if (!wallet) throw new Error('wallet_not_found');

    await this.prisma.wallet.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });

    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { isDefault: true },
    });
  }
}
