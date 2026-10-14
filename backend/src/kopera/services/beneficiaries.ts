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

  async getActivityScore(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });

    if (beneficiaries.length === 0) {
      return {
        totalBeneficiaries: 0,
        avgScore: 0,
        scores: [],
      };
    }

    const transactions = await this.prisma.transaction.findMany({
      where: { userId, status: 'COMPLETED' },
    });

    const now = Date.now();
    const scores = beneficiaries.map((b) => {
      const related = transactions.filter(
        (t) => t.counterpartyName === b.nickname || t.receiverWalletId === b.id,
      );
      const totalVolume = related.reduce((s, t) => s + t.amount, BigInt(0));
      const txCount = related.length;

      const recencyDays = related.length > 0
        ? Math.max(
            ...related.map((t) => {
              const d = t.processedAt ?? t.createdAt;
              return d ? Math.floor((now - new Date(d).getTime()) / 86400000) : 999;
            }),
          )
        : null;

      let recencyScore = 0;
      if (recencyDays !== null) {
        if (recencyDays <= 7) recencyScore = 100;
        else if (recencyDays <= 30) recencyScore = 70;
        else if (recencyDays <= 90) recencyScore = 40;
        else recencyScore = 10;
      }

      const frequencyScore = Math.min(100, txCount * 20);
      const activityScore = Math.round((recencyScore * 0.6 + frequencyScore * 0.4) * 100) / 100;

      return {
        beneficiaryId: b.id,
        nickname: b.nickname,
        transactionCount: txCount,
        totalVolume: totalVolume.toString(),
        lastActivityDaysAgo: recencyDays,
        activityScore,
      };
    }).sort((a, b) => b.activityScore - a.activityScore);

    const avgScore = Math.round(
      (scores.reduce((s, sc) => s + sc.activityScore, 0) / scores.length) * 100
    ) / 100;

    return {
      totalBeneficiaries: beneficiaries.length,
      avgScore,
      scores,
    };
  }

  async getDormancyReport(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });

    if (beneficiaries.length === 0) {
      return {
        totalBeneficiaries: 0,
        activeCount: 0,
        dormantCount: 0,
        dormancyRate: 0,
        dormant: [],
        recommendation: 'No beneficiaries found.',
      };
    }

    const transactions = await this.prisma.transaction.findMany({
      where: { userId, status: 'COMPLETED' },
    });

    const now = Date.now();
    const dormantThreshold = 90;

    const entries = beneficiaries.map((b) => {
      const related = transactions.filter(
        (t) => t.counterpartyName === b.nickname || t.receiverWalletId === b.id,
      );

      let lastUsedDaysAgo: number | null = null;
      if (related.length > 0) {
        const latest = Math.max(...related.map(t => new Date(t.processedAt ?? t.createdAt).getTime()));
        lastUsedDaysAgo = Math.floor((now - latest) / 86400000);
      }

      const isDormant = lastUsedDaysAgo === null || lastUsedDaysAgo > dormantThreshold;

      return {
        beneficiaryId: b.id,
        nickname: b.nickname,
        currency: b.currency,
        transactionCount: related.length,
        lastUsedDaysAgo,
        isDormant,
      };
    });

    const dormant = entries.filter(e => e.isDormant).sort((a, b) => {
      if (a.lastUsedDaysAgo === null) return -1;
      if (b.lastUsedDaysAgo === null) return 1;
      return b.lastUsedDaysAgo - a.lastUsedDaysAgo;
    });
    const activeCount = entries.length - dormant.length;
    const dormancyRate = Math.round((dormant.length / entries.length) * 10000) / 100;

    let recommendation: string;
    if (dormant.length === 0) {
      recommendation = 'All beneficiaries are actively used.';
    } else if (dormancyRate > 50) {
      recommendation = `${dormant.length} dormant beneficiaries could be cleaned up to simplify your list.`;
    } else {
      recommendation = `A few inactive beneficiaries detected. Consider reviewing them periodically.`;
    }

    return {
      totalBeneficiaries: beneficiaries.length,
      activeCount,
      dormantCount: dormant.length,
      dormancyRate,
      dormant,
      recommendation,
    };
  }

  async getBeneficiaryTrustScore(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });
    if (beneficiaries.length === 0) {
      return {
        totalBeneficiaries: 0,
        avgTrustScore: 0,
        highTrust: 0,
        mediumTrust: 0,
        lowTrust: 0,
        scores: [],
      };
    }

    const now = Date.now();
    const scores: { beneficiaryId: string; name: string; trustScore: number; trustLevel: string; factors: string[] }[] = [];

    for (const b of beneficiaries) {
      let score = 0;
      const factors: string[] = [];

      const ageDays = (now - new Date(b.createdAt).getTime()) / 86400000;
      if (ageDays > 365) { score += 30; factors.push('long_standing'); }
      else if (ageDays > 90) { score += 20; factors.push('established'); }
      else if (ageDays > 30) { score += 10; factors.push('recent'); }
      else { score += 5; factors.push('new'); }

      if ((b as any).verified || (b as any).status === 'verified') {
        score += 25;
        factors.push('verified');
      }

      if ((b as any).bankAccountNumber || (b as any).accountNumber) {
        score += 15;
        factors.push('has_account_details');
      }

      if ((b as any).lastTransferAt) {
        const daysSinceTransfer = (now - new Date((b as any).lastTransferAt).getTime()) / 86400000;
        if (daysSinceTransfer < 30) { score += 20; factors.push('recently_used'); }
        else if (daysSinceTransfer < 90) { score += 10; factors.push('used_recently'); }
      }

      if ((b as any).email || (b as any).phone) {
        score += 10;
        factors.push('has_contact_info');
      }

      score = Math.min(100, score);
      const trustLevel = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';

      scores.push({
        beneficiaryId: b.id,
        name: (b as any).name || (b as any).nickName || 'Unknown',
        trustScore: score,
        trustLevel,
        factors,
      });
    }

    scores.sort((a, b) => b.trustScore - a.trustScore);

    const avgTrustScore = Math.round(scores.reduce((s, sc) => s + sc.trustScore, 0) / scores.length);
    const highTrust = scores.filter(s => s.trustLevel === 'high').length;
    const mediumTrust = scores.filter(s => s.trustLevel === 'medium').length;
    const lowTrust = scores.filter(s => s.trustLevel === 'low').length;

    return {
      totalBeneficiaries: beneficiaries.length,
      avgTrustScore,
      highTrust,
      mediumTrust,
      lowTrust,
      scores,
    };
  }

  async getBeneficiaryGeographicSpread(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });
    if (beneficiaries.length === 0) {
      return {
        totalBeneficiaries: 0,
        countries: [],
        topCountry: null,
        diversityScore: 0,
        domestic: 0,
        international: 0,
      };
    }

    const byCountry: Record<string, number> = {};
    let domestic = 0;
    let international = 0;
    const userCountry = (beneficiaries[0] as any).senderCountry || null;

    for (const b of beneficiaries) {
      const country = (b as any).country || (b as any).bankCountry || 'UNKNOWN';
      byCountry[country] = (byCountry[country] || 0) + 1;
      if (userCountry && country === userCountry) domestic++;
      else international++;
    }

    const countries = Object.entries(byCountry)
      .map(([country, count]) => ({
        country,
        count,
        percentage: Math.round((count / beneficiaries.length) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    const topCountry = countries[0] || null;

    const shares = countries.map(c => c.count / beneficiaries.length);
    const hhi = shares.reduce((s, p) => s + p * p, 0);
    const diversityScore = Math.round((1 - hhi) * 100);

    return {
      totalBeneficiaries: beneficiaries.length,
      countries,
      topCountry,
      diversityScore,
      domestic,
      international,
    };
  }

  async getBeneficiaryPaymentFrequency(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });

    if (beneficiaries.length === 0) {
      return {
        totalBeneficiaries: 0,
        frequentRecipients: [] as { beneficiaryId: string; nickname: string; transactionCount: number; lastTransactionDate: string | null }[],
        dormantRecipients: [] as { beneficiaryId: string; nickname: string; daysSinceLastPayment: number | null }[],
        avgTransactionsPerBeneficiary: 0,
        recommendations: [] as string[],
      };
    }

    const transactions = await this.prisma.transaction.findMany({ where: { userId } });
    const now = Date.now();

    const beneficiaryStats = beneficiaries.map(b => {
      const bTxns = transactions.filter(t =>
        (t as any).recipientId === b.id ||
        (t as any).beneficiaryId === b.id ||
        (t as any).counterpartyId === b.id
      );

      const lastTxn = bTxns.length > 0
        ? new Date(Math.max(...bTxns.map(t => new Date(t.createdAt).getTime())))
        : null;

      const daysSinceLastPayment = lastTxn
        ? Math.floor((now - lastTxn.getTime()) / 86400000)
        : null;

      return {
        beneficiaryId: b.id,
        nickname: (b as any).nickname || (b as any).name || b.id,
        transactionCount: bTxns.length,
        lastTransactionDate: lastTxn?.toISOString() || null,
        daysSinceLastPayment,
      };
    });

    const frequent = beneficiaryStats
      .filter(b => b.transactionCount > 0)
      .sort((a, b) => b.transactionCount - a.transactionCount)
      .slice(0, 10)
      .map(({ daysSinceLastPayment: _, ...rest }) => rest);

    const dormant = beneficiaryStats
      .filter(b => b.daysSinceLastPayment === null || b.daysSinceLastPayment > 90)
      .map(({ transactionCount: _, lastTransactionDate: __, ...rest }) => rest);

    const totalTxns = beneficiaryStats.reduce((s, b) => s + b.transactionCount, 0);
    const avgTxns = beneficiaries.length > 0
      ? Number((totalTxns / beneficiaries.length).toFixed(2))
      : 0;

    const recommendations: string[] = [];
    if (dormant.length > beneficiaries.length * 0.5) recommendations.push('Over half of beneficiaries are dormant — consider cleanup');
    if (frequent.length === 1) recommendations.push('Payments concentrated to a single recipient');
    if (avgTxns < 1) recommendations.push('Low average transactions per beneficiary — review recipient list relevance');

    return {
      totalBeneficiaries: beneficiaries.length,
      frequentRecipients: frequent,
      dormantRecipients: dormant,
      avgTransactionsPerBeneficiary: avgTxns,
      recommendations,
    };
  }

  async getBeneficiaryRiskConcentration(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });
    if (beneficiaries.length === 0) {
      return {
        totalBeneficiaries: 0,
        concentrationScore: 0,
        concentrationLevel: 'no_data',
        topRecipients: [],
        recommendations: [],
      };
    }

    const countryMap: Record<string, number> = {};
    const currencyMap: Record<string, number> = {};

    for (const b of beneficiaries) {
      const country = (b as any).country || (b as any).bankCountry || 'unknown';
      const currency = (b as any).currency || 'unknown';
      countryMap[country] = (countryMap[country] || 0) + 1;
      currencyMap[currency] = (currencyMap[currency] || 0) + 1;
    }

    let concentrationScore = 0;
    const countryEntries = Object.entries(countryMap);
    for (const [, count] of countryEntries) {
      const share = count / beneficiaries.length;
      concentrationScore += Math.round(share * share * 10000);
    }
    concentrationScore = Math.min(10000, concentrationScore);

    const concentrationLevel = concentrationScore > 5000 ? 'concentrated'
      : concentrationScore > 2500 ? 'moderate' : 'diversified';

    const topRecipients = countryEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([country, count]) => ({
        country,
        count,
        sharePercent: Math.round((count / beneficiaries.length) * 10000) / 100,
      }));

    const recommendations: string[] = [];
    if (concentrationLevel === 'concentrated') recommendations.push('Beneficiaries concentrated in few countries — consider diversification');
    if (Object.keys(currencyMap).length === 1) recommendations.push('All beneficiaries use single currency — multi-currency may reduce FX costs');
    if (beneficiaries.length > 20) recommendations.push('Large beneficiary list — review for inactive or duplicate entries');

    return {
      totalBeneficiaries: beneficiaries.length,
      concentrationScore,
      concentrationLevel,
      topRecipients,
      currencyDistribution: currencyMap,
      recommendations,
    };
  }

  async getBeneficiaryVerificationStatus(userId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({ where: { userId } });

    if (beneficiaries.length === 0) {
      return {
        totalBeneficiaries: 0,
        verificationScore: 0,
        verificationLevel: 'no_data' as const,
        breakdown: { verified: 0, pending: 0, unverified: 0 },
        recommendations: [] as string[],
      };
    }

    let verifiedCount = 0;
    let pendingCount = 0;
    let unverifiedCount = 0;

    for (const b of beneficiaries) {
      const status = (b as any).verificationStatus ?? (b as any).verified ? 'verified' : 'unverified';
      if (status === 'verified' || (b as any).verified === true) verifiedCount++;
      else if (status === 'pending') pendingCount++;
      else unverifiedCount++;
    }

    const verificationRate = Math.round((verifiedCount / beneficiaries.length) * 100);

    let verificationScore = verificationRate;
    if (unverifiedCount > beneficiaries.length / 2) verificationScore = Math.max(0, verificationScore - 20);
    if (pendingCount > 5) verificationScore = Math.max(0, verificationScore - 10);

    const verificationLevel = verificationScore >= 80 ? 'strong'
      : verificationScore >= 50 ? 'moderate' : 'weak';

    const recommendations: string[] = [];
    if (unverifiedCount > 0) recommendations.push(`Verify ${unverifiedCount} unverified beneficiary(ies) to improve security`);
    if (pendingCount > 0) recommendations.push(`${pendingCount} beneficiary(ies) pending verification — follow up`);
    if (verificationLevel === 'strong') recommendations.push('Beneficiary verification is in good shape');

    return {
      totalBeneficiaries: beneficiaries.length,
      verificationScore,
      verificationLevel,
      verificationRate,
      breakdown: { verified: verifiedCount, pending: pendingCount, unverified: unverifiedCount },
      recommendations,
    };
  }
}
