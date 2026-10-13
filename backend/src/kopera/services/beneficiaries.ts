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

  async listRecent(userId: string, limit: number = 5) {
    return this.prisma.beneficiary.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 20),
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

  async getBeneficiaryOverview(userId: string) {
    const all = await this.prisma.beneficiary.findMany({ where: { userId } });
    const byCurrency: Record<string, number> = {};
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let addedLast30Days = 0;

    for (const b of all) {
      const cur = (b as any).currency ?? 'UNSET';
      byCurrency[cur] = (byCurrency[cur] ?? 0) + 1;
      if (new Date(b.createdAt) >= thirtyDaysAgo) addedLast30Days++;
    }

    return { totalBeneficiaries: all.length, byCurrency, addedLast30Days };
  }

  async getTransferReadiness(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });
    const wallets = await this.prisma.wallet.findMany({ where: { userId, status: 'ACTIVE' } });

    const walletCurrencies = new Map<string, bigint>();
    for (const w of wallets) {
      walletCurrencies.set(w.currency, w.availableBalance);
    }

    const ready: Array<{ nickname: string; recipientUserId: string; currency: string; availableBalance: string }> = [];
    const notReady: Array<{ nickname: string; recipientUserId: string; reason: string }> = [];

    for (const b of beneficiaries) {
      const cur = (b as any).currency;
      if (!cur) {
        notReady.push({ nickname: b.nickname, recipientUserId: b.recipientUserId, reason: 'no_currency_set' });
        continue;
      }
      const balance = walletCurrencies.get(cur);
      if (balance === undefined) {
        notReady.push({ nickname: b.nickname, recipientUserId: b.recipientUserId, reason: 'no_matching_wallet' });
      } else if (balance <= BigInt(0)) {
        notReady.push({ nickname: b.nickname, recipientUserId: b.recipientUserId, reason: 'zero_balance' });
      } else {
        ready.push({ nickname: b.nickname, recipientUserId: b.recipientUserId, currency: cur, availableBalance: balance.toString() });
      }
    }

    return {
      totalBeneficiaries: beneficiaries.length,
      readyCount: ready.length,
      notReadyCount: notReady.length,
      ready,
      notReady,
    };
  }

  async getNetworkMap(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });
    const txns = await this.prisma.transaction.findMany({
      where: { userId, type: 'TRANSFER', status: 'COMPLETED' },
    });

    const recipientMap: Record<string, { nickname: string; currency: string | null; transferCount: number; totalVolume: bigint; lastTransferAt: Date | null }> = {};

    for (const b of beneficiaries) {
      recipientMap[b.recipientUserId] = {
        nickname: b.nickname,
        currency: (b as any).currency ?? null,
        transferCount: 0,
        totalVolume: BigInt(0),
        lastTransferAt: null,
      };
    }

    for (const t of txns) {
      const recipientId = (t as any).receiverWalletId ? undefined : null;
      for (const [rid, entry] of Object.entries(recipientMap)) {
        const matchesSender = (t as any).senderWalletId !== undefined;
        if (matchesSender) {
          entry.transferCount++;
          entry.totalVolume += t.amount;
          const txDate = t.processedAt ?? t.createdAt;
          if (!entry.lastTransferAt || txDate > entry.lastTransferAt) entry.lastTransferAt = txDate;
        }
      }
    }

    const frequentRecipients = Object.entries(recipientMap)
      .filter(([, v]) => v.transferCount > 0)
      .sort((a, b) => b[1].transferCount - a[1].transferCount)
      .slice(0, 5)
      .map(([recipientId, data]) => ({ recipientId, ...data, totalVolume: data.totalVolume }));

    const dormantBeneficiaries = Object.entries(recipientMap)
      .filter(([, v]) => v.transferCount === 0)
      .map(([recipientId, data]) => ({ recipientId, nickname: data.nickname, currency: data.currency }));

    const byCurrency: Record<string, number> = {};
    for (const b of beneficiaries) {
      const cur = (b as any).currency ?? 'UNSET';
      byCurrency[cur] = (byCurrency[cur] ?? 0) + 1;
    }

    return {
      totalBeneficiaries: beneficiaries.length,
      activeRecipients: frequentRecipients.length,
      dormantCount: dormantBeneficiaries.length,
      byCurrency,
      frequentRecipients,
      dormantBeneficiaries,
    };
  }

  async getCurrencyExposure(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });
    const wallets = await this.prisma.wallet.findMany({ where: { userId, status: 'ACTIVE' } });

    const beneficiaryCurrencies = new Set<string>();
    const walletCurrencies = new Set<string>();
    const byCurrency: Record<string, { beneficiaryCount: number; walletBalance: string; hasWallet: boolean }> = {};

    for (const b of beneficiaries) {
      const cur = (b as any).currency;
      if (cur) {
        beneficiaryCurrencies.add(cur);
        if (!byCurrency[cur]) byCurrency[cur] = { beneficiaryCount: 0, walletBalance: '0', hasWallet: false };
        byCurrency[cur].beneficiaryCount++;
      }
    }

    for (const w of wallets) {
      walletCurrencies.add(w.currency);
      if (!byCurrency[w.currency]) byCurrency[w.currency] = { beneficiaryCount: 0, walletBalance: '0', hasWallet: false };
      byCurrency[w.currency].walletBalance = w.availableBalance.toString();
      byCurrency[w.currency].hasWallet = true;
    }

    const allCurrencies = new Set([...beneficiaryCurrencies, ...walletCurrencies]);
    const coveredCurrencies = [...allCurrencies].filter(c => beneficiaryCurrencies.has(c) && walletCurrencies.has(c));
    const gaps = [...allCurrencies].filter(c => walletCurrencies.has(c) && !beneficiaryCurrencies.has(c));
    const unmatched = [...allCurrencies].filter(c => beneficiaryCurrencies.has(c) && !walletCurrencies.has(c));
    const noCurrency = beneficiaries.filter((b: any) => !(b as any).currency).length;

    return {
      totalBeneficiaries: beneficiaries.length,
      totalWallets: wallets.length,
      coveredCurrencies,
      gaps,
      unmatchedBeneficiaries: unmatched,
      noCurrencySet: noCurrency,
      byCurrency,
    };
  }

  async remove(beneficiaryId: string, userId: string) {
    const b = await this.prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!b) throw new Error('beneficiary_not_found');
    if (b.userId !== userId) throw new Error('forbidden');

    return this.prisma.beneficiary.delete({ where: { id: beneficiaryId } });
  }
}
