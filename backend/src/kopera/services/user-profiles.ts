import type { PrismaClient } from '@prisma/client';

export class UserProfileService {
  constructor(private prisma: PrismaClient) {}

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({ where: { id: userId } });
  }

  async updateProfile(userId: string, data: {
    name?: string;
    phone?: string;
    locale?: string;
    timezone?: string;
    country?: string;
    preferredCurrency?: string;
  }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');

    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  async enableMfa(userId: string, secret: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (user.mfaEnabled) throw new Error('mfa_already_enabled');

    return this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: secret, mfaEnabled: true },
    });
  }

  async disableMfa(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (!user.mfaEnabled) throw new Error('mfa_not_enabled');

    return this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaEnabled: false },
    });
  }

  async setPin(userId: string, pinHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { pinHash },
    });
  }

  async deactivateAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (user.status === 'DEACTIVATED') throw new Error('already_deactivated');

    return this.prisma.user.update({
      where: { id: userId },
      data: { status: 'DEACTIVATED' },
    });
  }

  async upgradeToBusinessAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user_not_found');
    if (user.accountType === 'BUSINESS') throw new Error('already_business');

    return this.prisma.user.update({
      where: { id: userId },
      data: { accountType: 'BUSINESS' },
    });
  }
}
