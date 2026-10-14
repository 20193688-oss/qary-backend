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

  async getSecurityPosture(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    let expiredCount = 0;
    let frozenCount = 0;
    let activeCount = 0;
    const byNetwork: Record<string, number> = {};
    const issues: string[] = [];

    for (const c of cards) {
      byNetwork[c.network] = (byNetwork[c.network] ?? 0) + 1;

      const isExpired = c.expiryYear < currentYear || (c.expiryYear === currentYear && c.expiryMonth < currentMonth);
      if (isExpired) {
        expiredCount++;
      } else if ((c as any).frozen) {
        frozenCount++;
      } else {
        activeCount++;
      }
    }

    if (expiredCount > 0) issues.push(`${expiredCount} expired card(s) should be removed`);
    if (!cards.some((c: any) => c.isDefault) && cards.length > 0) issues.push('No default card set');
    if (Object.keys(byNetwork).length === 1 && cards.length > 1) issues.push('All cards on one network — consider diversifying');

    const fingerprintCount = cards.filter((c: any) => c.fingerprint).length;
    const duplicateCheck = new Set(cards.filter((c: any) => c.fingerprint).map((c: any) => c.fingerprint));
    if (fingerprintCount > duplicateCheck.size) issues.push('Possible duplicate cards detected');

    let securityScore = 100;
    securityScore -= expiredCount * 15;
    securityScore -= issues.length * 10;
    if (!cards.some((c: any) => c.isDefault) && cards.length > 0) securityScore -= 5;
    securityScore = Math.max(0, securityScore);

    let grade: string;
    if (securityScore >= 90) grade = 'EXCELLENT';
    else if (securityScore >= 70) grade = 'GOOD';
    else if (securityScore >= 50) grade = 'FAIR';
    else grade = 'POOR';

    return {
      totalCards: cards.length,
      activeCount,
      frozenCount,
      expiredCount,
      securityScore,
      grade,
      byNetwork,
      issues,
    };
  }

  async getNetworkDiversification(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });

    if (cards.length === 0) {
      return {
        totalCards: 0,
        distinctNetworks: 0,
        concentrationIndex: 0,
        coverage: 'none' as const,
        dominantNetwork: null,
        byNetwork: [],
      };
    }

    const networkCounts: Record<string, number> = {};
    for (const c of cards) {
      networkCounts[c.network] = (networkCounts[c.network] ?? 0) + 1;
    }

    const distinctNetworks = Object.keys(networkCounts).length;

    let hhi = 0;
    for (const count of Object.values(networkCounts)) {
      const share = count / cards.length;
      hhi += share * share;
    }
    const concentrationIndex = Math.round(hhi * 10000) / 100;

    let coverage: string;
    if (distinctNetworks >= 4) coverage = 'excellent';
    else if (distinctNetworks >= 3) coverage = 'diverse';
    else if (distinctNetworks >= 2) coverage = 'limited';
    else coverage = 'single';

    const byNetwork = Object.entries(networkCounts)
      .map(([network, count]) => ({
        network,
        count,
        sharePercent: Math.round(count / cards.length * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    const dominantNetwork = byNetwork[0]?.network ?? null;

    return {
      totalCards: cards.length,
      distinctNetworks,
      concentrationIndex,
      coverage,
      dominantNetwork,
      byNetwork,
    };
  }

  async getBankDistribution(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });

    if (cards.length === 0) {
      return {
        totalCards: 0,
        distinctBanks: 0,
        byBank: [],
        dominantBank: null,
      };
    }

    const bankMap = new Map<string, number>();
    for (const c of cards) {
      const bank = (c as any).bankName ?? 'Unknown';
      bankMap.set(bank, (bankMap.get(bank) ?? 0) + 1);
    }

    const byBank = Array.from(bankMap.entries())
      .map(([bank, count]) => ({
        bank,
        count,
        share: Math.round((count / cards.length) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCards: cards.length,
      distinctBanks: bankMap.size,
      byBank,
      dominantBank: byBank[0]?.bank ?? null,
    };
  }

  async getTokenLifecycleAnalysis(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });
    if (cards.length === 0) {
      return {
        totalCards: 0,
        byStatus: { active: 0, expired: 0, frozen: 0 },
        avgAgeDays: 0,
        avgMonthsUntilExpiry: 0,
        turnoverRate: 0,
        lifecycleHealth: 'none' as const,
        expiringWithin90Days: [],
      };
    }

    const now = Date.now();
    const nowDate = new Date();
    const currentMonth = nowDate.getMonth() + 1;
    const currentYear = nowDate.getFullYear();

    let activeCount = 0;
    let expiredCount = 0;
    let frozenCount = 0;
    let totalAgeDays = 0;
    let totalMonthsUntilExpiry = 0;
    let activeWithExpiry = 0;
    const expiringWithin90Days: { last4: string; network: string; expiryMonth: number; expiryYear: number; daysUntilExpiry: number }[] = [];

    for (const card of cards) {
      const c = card as any;
      const ageDays = Math.floor((now - new Date(c.createdAt).getTime()) / 86400000);
      totalAgeDays += ageDays;

      if (c.frozen) {
        frozenCount++;
      } else {
        const expiryDate = new Date(c.expiryYear, c.expiryMonth - 1, 28);
        if (expiryDate < nowDate) {
          expiredCount++;
        } else {
          activeCount++;
          const monthsUntil = (c.expiryYear - currentYear) * 12 + (c.expiryMonth - currentMonth);
          totalMonthsUntilExpiry += monthsUntil;
          activeWithExpiry++;

          const daysUntilExpiry = Math.floor((expiryDate.getTime() - now) / 86400000);
          if (daysUntilExpiry <= 90) {
            expiringWithin90Days.push({
              last4: c.last4,
              network: c.network,
              expiryMonth: c.expiryMonth,
              expiryYear: c.expiryYear,
              daysUntilExpiry,
            });
          }
        }
      }
    }

    const avgAgeDays = Math.round(totalAgeDays / cards.length);
    const avgMonthsUntilExpiry = activeWithExpiry > 0
      ? Math.round((totalMonthsUntilExpiry / activeWithExpiry) * 10) / 10
      : 0;
    const turnoverRate = Math.round(((expiredCount + frozenCount) / cards.length) * 10000) / 100;

    const activeRatio = activeCount / cards.length;
    const lifecycleHealth = activeRatio >= 0.8 ? 'healthy'
      : activeRatio >= 0.5 ? 'fair'
      : activeRatio > 0 ? 'needs_attention'
      : 'critical';

    expiringWithin90Days.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

    return {
      totalCards: cards.length,
      byStatus: { active: activeCount, expired: expiredCount, frozen: frozenCount },
      avgAgeDays,
      avgMonthsUntilExpiry,
      turnoverRate,
      lifecycleHealth,
      expiringWithin90Days,
    };
  }

  async getSpendingByCard(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });

    if (cards.length === 0) {
      return {
        totalCards: 0,
        cardsWithTransactions: 0,
        byCard: [],
        mostUsedCard: null,
        totalSpent: '0',
      };
    }

    const allTxns = await this.prisma.transaction.findMany({ where: { userId } });

    const cardSpend = new Map<string, { count: number; total: number; lastUsed: Date | null }>();
    for (const card of cards) {
      cardSpend.set(card.id, { count: 0, total: 0, lastUsed: null });
    }

    for (const txn of allTxns) {
      const cardId = (txn as any).tokenizedCardId ?? (txn as any).cardId;
      if (cardId && cardSpend.has(cardId)) {
        const entry = cardSpend.get(cardId)!;
        entry.count++;
        entry.total += Number(txn.amount);
        const txnDate = new Date(txn.createdAt);
        if (!entry.lastUsed || txnDate > entry.lastUsed) entry.lastUsed = txnDate;
      }
    }

    const byCard = cards.map((card) => {
      const spend = cardSpend.get(card.id)!;
      return {
        cardId: card.id,
        lastFour: card.lastFour,
        network: card.network,
        status: card.status,
        transactionCount: spend.count,
        totalSpent: spend.total.toString(),
        lastUsed: spend.lastUsed,
      };
    }).sort((a, b) => b.transactionCount - a.transactionCount);

    const cardsWithTransactions = byCard.filter((c) => c.transactionCount > 0).length;
    const totalSpent = byCard.reduce((s, c) => s + Number(c.totalSpent), 0);

    return {
      totalCards: cards.length,
      cardsWithTransactions,
      byCard,
      mostUsedCard: byCard[0]?.transactionCount > 0 ? byCard[0].lastFour : null,
      totalSpent: totalSpent.toString(),
    };
  }

  async removeCard(id: string, userId: string) {
    const card = await this.prisma.tokenizedCard.findUnique({ where: { id } });
    if (!card) throw new Error('card_not_found');
    if (card.userId !== userId) throw new Error('forbidden');
    return this.prisma.tokenizedCard.delete({ where: { id } });
  }

  async getCardFraudRiskAssessment(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });
    if (cards.length === 0) {
      return {
        totalCards: 0,
        overallRiskScore: 0,
        riskLevel: 'none',
        cardRisks: [],
        recommendations: [],
      };
    }

    const now = new Date();
    const recommendations: string[] = [];
    const cardRisks: { cardId: string; last4: string; riskScore: number; factors: string[] }[] = [];

    for (const card of cards) {
      let score = 0;
      const factors: string[] = [];

      if ((card as any).frozen) {
        score += 10;
        factors.push('card_frozen');
      }

      const expMonth = (card as any).expiryMonth || 12;
      const expYear = (card as any).expiryYear || now.getFullYear() + 1;
      const expiryDate = new Date(expYear, expMonth - 1);
      if (expiryDate < now) {
        score += 30;
        factors.push('expired');
      } else {
        const monthsToExpiry = (expiryDate.getTime() - now.getTime()) / (30 * 86400000);
        if (monthsToExpiry < 2) {
          score += 15;
          factors.push('expiring_soon');
        }
      }

      if (!(card as any).holderName) {
        score += 5;
        factors.push('missing_holder_name');
      }

      if (!(card as any).country) {
        score += 10;
        factors.push('unknown_country');
      }

      cardRisks.push({
        cardId: card.id,
        last4: (card as any).last4 || '****',
        riskScore: Math.min(100, score),
        factors,
      });
    }

    const avgScore = cardRisks.reduce((s, c) => s + c.riskScore, 0) / cardRisks.length;
    const overallRiskScore = Math.round(avgScore);
    const riskLevel = overallRiskScore >= 50 ? 'high' : overallRiskScore >= 25 ? 'medium' : 'low';

    const expired = cardRisks.filter(c => c.factors.includes('expired'));
    if (expired.length > 0) recommendations.push(`${expired.length} expired card(s) should be removed`);
    const frozen = cardRisks.filter(c => c.factors.includes('card_frozen'));
    if (frozen.length > 0) recommendations.push(`${frozen.length} frozen card(s) need review`);

    return {
      totalCards: cards.length,
      overallRiskScore,
      riskLevel,
      cardRisks,
      recommendations,
    };
  }

  async getCardUtilizationTrend(userId: string) {
    const cards = await this.prisma.tokenizedCard.findMany({ where: { userId } });

    if (cards.length === 0) {
      return {
        totalCards: 0,
        activeCards: 0,
        dormantCards: 0,
        avgUsageFrequency: 0,
        cardTrends: [] as { cardId: string; last4: string; status: string; daysSinceLastUse: number | null; usageLevel: string }[],
        recommendations: [] as string[],
      };
    }

    const now = Date.now();
    let activeCount = 0;
    let dormantCount = 0;
    const trends: { cardId: string; last4: string; status: string; daysSinceLastUse: number | null; usageLevel: string }[] = [];

    for (const card of cards) {
      const status = ((card as any).status || '').toLowerCase();
      const lastUsed = (card as any).lastUsedAt || (card as any).updatedAt;
      const daysSinceLastUse = lastUsed
        ? Math.floor((now - new Date(lastUsed).getTime()) / 86400000)
        : null;

      let usageLevel: string;
      if (status === 'frozen' || status === 'expired') {
        usageLevel = 'inactive';
      } else if (daysSinceLastUse === null || daysSinceLastUse > 90) {
        usageLevel = 'dormant';
        dormantCount++;
      } else if (daysSinceLastUse > 30) {
        usageLevel = 'low';
        activeCount++;
      } else {
        usageLevel = 'active';
        activeCount++;
      }

      trends.push({
        cardId: card.id,
        last4: (card as any).last4 || '****',
        status,
        daysSinceLastUse,
        usageLevel,
      });
    }

    const usageDays = trends.filter(t => t.daysSinceLastUse !== null).map(t => t.daysSinceLastUse!);
    const avgUsageFrequency = usageDays.length > 0
      ? Number((usageDays.reduce((a, b) => a + b, 0) / usageDays.length).toFixed(1))
      : 0;

    const recommendations: string[] = [];
    if (dormantCount > 0) recommendations.push(`${dormantCount} card(s) unused for 90+ days — consider removing them`);
    if (activeCount === 0 && cards.length > 0) recommendations.push('No actively used cards — verify payment methods are up to date');
    if (trends.filter(t => t.usageLevel === 'low').length > cards.length * 0.5) {
      recommendations.push('Over half of cards have low usage — consolidate to fewer cards');
    }

    return {
      totalCards: cards.length,
      activeCards: activeCount,
      dormantCards: dormantCount,
      avgUsageFrequency,
      cardTrends: trends,
      recommendations,
    };
  }
}
