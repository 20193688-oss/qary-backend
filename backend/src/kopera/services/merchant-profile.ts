import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class MerchantProfileService {
  constructor(private prisma: PrismaClient) {}

  async createProfile(userId: string, data: {
    merchantName: string;
    merchantCode: string;
    category: string;
    country: string;
    currency: string;
    contactEmail?: string;
    website?: string;
  }) {
    const existing = await this.prisma.merchantProfile.findFirst({
      where: { userId, merchantCode: data.merchantCode.toUpperCase() },
    });
    if (existing) throw new Error('merchant_code_exists');

    return this.prisma.merchantProfile.create({
      data: {
        userId,
        merchantName: data.merchantName,
        merchantCode: data.merchantCode.toUpperCase(),
        category: data.category,
        country: data.country.toUpperCase(),
        currency: data.currency.toUpperCase(),
        contactEmail: data.contactEmail || null,
        website: data.website || null,
        status: 'ACTIVE',
        transactionCount: 0,
        totalVolume: BigInt(0),
        reference: `MRC-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getProfiles(userId: string) {
    return this.prisma.merchantProfile.findMany({ where: { userId } });
  }

  async getProfile(userId: string, id: string) {
    const profile = await this.prisma.merchantProfile.findUnique({ where: { id } });
    if (!profile) throw new Error('merchant_not_found');
    if ((profile as any).userId !== userId) throw new Error('merchant_not_found');
    return profile;
  }

  async updateProfile(userId: string, id: string, data: {
    merchantName?: string;
    category?: string;
    contactEmail?: string;
    website?: string;
  }) {
    await this.getProfile(userId, id);
    const updateData: Record<string, unknown> = {};
    if (data.merchantName !== undefined) updateData.merchantName = data.merchantName;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.contactEmail !== undefined) updateData.contactEmail = data.contactEmail;
    if (data.website !== undefined) updateData.website = data.website;

    return this.prisma.merchantProfile.update({ where: { id }, data: updateData });
  }

  async suspendProfile(userId: string, id: string) {
    const profile = await this.getProfile(userId, id);
    if ((profile as any).status === 'SUSPENDED') throw new Error('merchant_already_suspended');

    return this.prisma.merchantProfile.update({
      where: { id },
      data: { status: 'SUSPENDED', suspendedAt: new Date() },
    });
  }

  async activateProfile(userId: string, id: string) {
    const profile = await this.getProfile(userId, id);
    if ((profile as any).status === 'ACTIVE') throw new Error('merchant_already_active');

    return this.prisma.merchantProfile.update({
      where: { id },
      data: { status: 'ACTIVE', suspendedAt: null },
    });
  }

  async recordTransaction(userId: string, id: string, amount: bigint) {
    const profile = await this.getProfile(userId, id);
    return this.prisma.merchantProfile.update({
      where: { id },
      data: {
        transactionCount: ((profile as any).transactionCount || 0) + 1,
        totalVolume: ((profile as any).totalVolume as bigint) + amount,
      },
    });
  }

  async getMerchantAnalytics(userId: string) {
    const profiles = await this.prisma.merchantProfile.findMany({ where: { userId } });

    if (profiles.length === 0) {
      return {
        totalMerchants: 0,
        activeMerchants: 0,
        categories: {},
        countries: [],
        totalVolume: '0',
        analyticsLevel: 'no_data',
      };
    }

    const active = (profiles as any[]).filter((p) => p.status === 'ACTIVE').length;
    const categories: Record<string, number> = {};
    const countries = new Set<string>();
    let totalVolume = BigInt(0);
    for (const p of profiles as any[]) {
      categories[p.category] = (categories[p.category] || 0) + 1;
      countries.add(p.country);
      totalVolume += p.totalVolume as bigint;
    }

    return {
      totalMerchants: profiles.length,
      activeMerchants: active,
      categories,
      countries: [...countries],
      totalVolume: totalVolume.toString(),
      analyticsLevel: profiles.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
