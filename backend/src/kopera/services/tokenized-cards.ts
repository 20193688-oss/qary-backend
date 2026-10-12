import type { PrismaClient, CardNetwork } from '@prisma/client';

export class TokenizedCardService {
  constructor(private prisma: PrismaClient) {}

  async addCard(userId: string, data: {
    vaultToken: string;
    last4: string;
    network: CardNetwork;
    expiryMonth: number;
    expiryYear: number;
    holderName?: string;
    country?: string;
    bankName?: string;
    fingerprint?: string;
  }) {
    if (data.fingerprint) {
      const dup = await this.prisma.tokenizedCard.findFirst({
        where: { userId, fingerprint: data.fingerprint },
      });
      if (dup) throw new Error('card_already_exists');
    }

    const hasCards = await this.prisma.tokenizedCard.count({ where: { userId } });
    return this.prisma.tokenizedCard.create({
      data: { userId, isDefault: hasCards === 0, ...data },
    });
  }

  async listCards(userId: string) {
    return this.prisma.tokenizedCard.findMany({ where: { userId } });
  }

  async getCard(id: string) {
    return this.prisma.tokenizedCard.findUnique({ where: { id } });
  }

  async setDefault(id: string, userId: string) {
    const card = await this.prisma.tokenizedCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if (card.userId !== userId) throw new Error('forbidden');

    await this.prisma.tokenizedCard.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
    return this.prisma.tokenizedCard.update({
      where: { id },
      data: { isDefault: true },
    });
  }

  async updateCard(id: string, userId: string, data: { expiryMonth?: number; expiryYear?: number; holderName?: string }) {
    const card = await this.prisma.tokenizedCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if (card.userId !== userId) throw new Error('forbidden');

    const updates: Record<string, unknown> = {};
    if (data.expiryMonth !== undefined) updates.expiryMonth = data.expiryMonth;
    if (data.expiryYear !== undefined) updates.expiryYear = data.expiryYear;
    if (data.holderName !== undefined) updates.holderName = data.holderName;

    return this.prisma.tokenizedCard.update({
      where: { id },
      data: updates as any,
    });
  }

  async freezeCard(id: string, userId: string) {
    const card = await this.prisma.tokenizedCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if (card.userId !== userId) throw new Error('forbidden');
    if ((card as any).frozen) throw new Error('already_frozen');

    return this.prisma.tokenizedCard.update({
      where: { id },
      data: { frozen: true } as any,
    });
  }

  async unfreezeCard(id: string, userId: string) {
    const card = await this.prisma.tokenizedCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if (card.userId !== userId) throw new Error('forbidden');
    if (!(card as any).frozen) throw new Error('not_frozen');

    return this.prisma.tokenizedCard.update({
      where: { id },
      data: { frozen: false } as any,
    });
  }

  async getCardStats(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });
    const byNetwork: Record<string, number> = {};
    let active = 0;
    let frozen = 0;

    for (const c of cards) {
      byNetwork[c.network] = (byNetwork[c.network] ?? 0) + 1;
      if ((c as any).frozen) frozen++;
      else active++;
    }

    return { totalCards: cards.length, active, frozen, byNetwork };
  }

  async checkExpiringCards(withinMonths: number = 2) {
    const now = new Date();
    const targetMonth = now.getMonth() + 1 + withinMonths;
    const targetYear = now.getFullYear() + Math.floor((targetMonth - 1) / 12);
    const normalizedMonth = ((targetMonth - 1) % 12) + 1;

    const allCards = await this.prisma.tokenizedCard.findMany({});
    return allCards.filter((c: any) => {
      if (c.expiryYear < now.getFullYear()) return true;
      if (c.expiryYear === now.getFullYear() && c.expiryMonth < now.getMonth() + 1) return true;
      if (c.expiryYear < targetYear) return true;
      if (c.expiryYear === targetYear && c.expiryMonth <= normalizedMonth) return true;
      return false;
    });
  }

  async getUsageAnalytics(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });
    const byNetwork: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let defaultCard: { id: string; last4: string; network: string } | null = null;
    let frozenCount = 0;
    const now = new Date();
    let expiringCount = 0;
    let expiredCount = 0;

    for (const c of cards) {
      byNetwork[c.network] = (byNetwork[c.network] ?? 0) + 1;
      if ((c as any).country) {
        byCountry[(c as any).country] = (byCountry[(c as any).country] ?? 0) + 1;
      }
      if (c.isDefault) defaultCard = { id: c.id, last4: c.last4, network: c.network };
      if ((c as any).frozen) frozenCount++;
      if (c.expiryYear < now.getFullYear() || (c.expiryYear === now.getFullYear() && c.expiryMonth < now.getMonth() + 1)) {
        expiredCount++;
      } else if (c.expiryYear === now.getFullYear() && c.expiryMonth <= now.getMonth() + 3) {
        expiringCount++;
      }
    }

    return {
      totalCards: cards.length,
      activeCards: cards.length - frozenCount,
      frozenCards: frozenCount,
      expiredCards: expiredCount,
      expiringSoonCards: expiringCount,
      byNetwork,
      byCountry,
      defaultCard,
    };
  }

  async getExpiryForecast(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const expired: Array<{ id: string; last4: string; network: string; expiryMonth: number; expiryYear: number }> = [];
    const expiringWithin3Months: typeof expired = [];
    const expiringWithin6Months: typeof expired = [];
    const safe: typeof expired = [];

    for (const c of cards) {
      const item = { id: c.id, last4: c.last4, network: c.network, expiryMonth: c.expiryMonth, expiryYear: c.expiryYear };
      const expiryDate = new Date(c.expiryYear, c.expiryMonth, 0);
      const monthsUntilExpiry = (c.expiryYear - currentYear) * 12 + (c.expiryMonth - currentMonth);

      if (expiryDate < now) {
        expired.push(item);
      } else if (monthsUntilExpiry <= 3) {
        expiringWithin3Months.push(item);
      } else if (monthsUntilExpiry <= 6) {
        expiringWithin6Months.push(item);
      } else {
        safe.push(item);
      }
    }

    const urgency = expired.length > 0 ? 'critical' : expiringWithin3Months.length > 0 ? 'warning' : 'ok';

    return {
      totalCards: cards.length,
      expired: expired.length,
      expiringWithin3Months: expiringWithin3Months.length,
      expiringWithin6Months: expiringWithin6Months.length,
      safe: safe.length,
      urgency,
      expiredCards: expired,
      soonExpiringCards: expiringWithin3Months,
    };
  }

  async removeCard(id: string, userId: string) {
    const card = await this.prisma.tokenizedCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if (card.userId !== userId) throw new Error('forbidden');
    return this.prisma.tokenizedCard.delete({ where: { id } });
  }
}
