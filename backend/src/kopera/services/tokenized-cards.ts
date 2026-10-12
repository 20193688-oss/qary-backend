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

  async removeCard(id: string, userId: string) {
    const card = await this.prisma.tokenizedCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if (card.userId !== userId) throw new Error('forbidden');
    return this.prisma.tokenizedCard.delete({ where: { id } });
  }
}
