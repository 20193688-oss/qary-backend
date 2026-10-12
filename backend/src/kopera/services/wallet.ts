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
