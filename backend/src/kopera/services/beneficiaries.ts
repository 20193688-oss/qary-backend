import type { PrismaClient } from '@prisma/client';

export class BeneficiaryService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    nickname: string;
    recipientUserId: string;
    currency?: string;
  }) {
    if (params.userId === params.recipientUserId) throw new Error('cannot_add_self');

    const recipient = await this.prisma.user.findUnique({
      where: { id: params.recipientUserId },
    });
    if (!recipient) throw new Error('recipient_not_found');

    const existing = await this.prisma.beneficiary.findFirst({
      where: { userId: params.userId, recipientUserId: params.recipientUserId },
    });
    if (existing) throw new Error('beneficiary_exists');

    return this.prisma.beneficiary.create({
      data: {
        userId: params.userId,
        nickname: params.nickname,
        recipientUserId: params.recipientUserId,
        recipientEmail: recipient.email,
        currency: params.currency?.toUpperCase() ?? null,
      },
    });
  }

  async listByUser(userId: string) {
    return this.prisma.beneficiary.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(beneficiaryId: string) {
    return this.prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
  }

  async update(beneficiaryId: string, userId: string, data: { nickname?: string; currency?: string }) {
    const b = await this.prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!b) throw new Error('beneficiary_not_found');
    if (b.userId !== userId) throw new Error('forbidden');

    return this.prisma.beneficiary.update({
      where: { id: beneficiaryId },
      data: {
        ...(data.nickname ? { nickname: data.nickname } : {}),
        ...(data.currency ? { currency: data.currency.toUpperCase() } : {}),
      },
    });
  }

  async search(userId: string, query: string) {
    const all = await this.prisma.beneficiary.findMany({ where: { userId } });
    const q = query.toLowerCase();
    return all.filter((b: any) =>
      b.nickname.toLowerCase().includes(q) ||
      (b.recipientEmail && b.recipientEmail.toLowerCase().includes(q))
    );
  }

  async remove(beneficiaryId: string, userId: string) {
    const b = await this.prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!b) throw new Error('beneficiary_not_found');
    if (b.userId !== userId) throw new Error('forbidden');

    return this.prisma.beneficiary.delete({ where: { id: beneficiaryId } });
  }
}
