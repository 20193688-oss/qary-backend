import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

export class VirtualCardService {
  constructor(private prisma: PrismaClient) {}

  async issueCard(userId: string, data: {
    cardName: string;
    currency: string;
    spendingLimit: bigint;
    expiresAt: Date;
    category?: string;
  }) {
    const cardNumber = `4${Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('')}`;
    const cardHash = createHash('sha256').update(cardNumber).digest('hex');
    const last4 = cardNumber.slice(-4);

    return this.prisma.virtualCard.create({
      data: {
        userId,
        cardName: data.cardName,
        cardHash,
        last4,
        currency: data.currency.toUpperCase(),
        spendingLimit: data.spendingLimit,
        currentSpend: BigInt(0),
        category: data.category || 'GENERAL',
        status: 'ACTIVE',
        expiresAt: data.expiresAt,
        reference: `VCC-${Date.now()}-${randomUUID().slice(0, 8)}`,
        issuedAt: new Date(),
      },
    });
  }

  async getCards(userId: string) {
    return this.prisma.virtualCard.findMany({ where: { userId } });
  }

  async getCard(userId: string, id: string) {
    const card = await this.prisma.virtualCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if ((card as any).userId !== userId) throw new Error('card_not_found');
    return card;
  }

  async recordSpend(userId: string, id: string, amount: bigint) {
    const card = await this.getCard(userId, id);
    if ((card as any).status !== 'ACTIVE') throw new Error('card_not_active');

    const newSpend = ((card as any).currentSpend as bigint) + amount;
    if (newSpend > ((card as any).spendingLimit as bigint)) throw new Error('spending_limit_exceeded');

    return this.prisma.virtualCard.update({
      where: { id },
      data: { currentSpend: newSpend, lastUsedAt: new Date() },
    });
  }

  async freezeCard(userId: string, id: string) {
    const card = await this.getCard(userId, id);
    if ((card as any).status !== 'ACTIVE') throw new Error('card_not_active');

    return this.prisma.virtualCard.update({
      where: { id },
      data: { status: 'FROZEN', frozenAt: new Date() },
    });
  }

  async unfreezeCard(userId: string, id: string) {
    const card = await this.getCard(userId, id);
    if ((card as any).status !== 'FROZEN') throw new Error('card_not_frozen');

    return this.prisma.virtualCard.update({
      where: { id },
      data: { status: 'ACTIVE', frozenAt: null },
    });
  }

  async cancelCard(userId: string, id: string) {
    const card = await this.getCard(userId, id);
    if ((card as any).status === 'CANCELLED') throw new Error('card_already_cancelled');

    return this.prisma.virtualCard.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async getCardAnalytics(userId: string) {
    const cards = await this.prisma.virtualCard.findMany({ where: { userId } });

    if (cards.length === 0) {
      return {
        totalCards: 0,
        breakdown: { ACTIVE: 0, FROZEN: 0, CANCELLED: 0 },
        totalSpend: '0',
        totalLimit: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ACTIVE: 0, FROZEN: 0, CANCELLED: 0 };
    let totalSpend = BigInt(0);
    let totalLimit = BigInt(0);
    for (const c of cards as any[]) {
      const status = c.status as string;
      if (status in breakdown) breakdown[status]++;
      totalSpend += c.currentSpend as bigint;
      totalLimit += c.spendingLimit as bigint;
    }

    return {
      totalCards: cards.length,
      breakdown,
      totalSpend: totalSpend.toString(),
      totalLimit: totalLimit.toString(),
      analyticsLevel: cards.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
