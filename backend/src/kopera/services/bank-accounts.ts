import type { PrismaClient, BankRail, Prisma } from '@prisma/client';

export class BankAccountService {
  constructor(private prisma: PrismaClient) {}

  async addAccount(userId: string, data: {
    bankName: string;
    bankCode?: string;
    accountNumber: string;
    accountType?: string;
    rail: BankRail;
    country: string;
    currency: string;
    holderName: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const existing = await this.prisma.bankAccount.findFirst({
      where: { userId, accountNumber: data.accountNumber, rail: data.rail as BankRail },
    });
    if (existing) throw new Error('account_already_exists');

    const hasAccounts = await this.prisma.bankAccount.count({ where: { userId } });
    return this.prisma.bankAccount.create({
      data: { userId, isDefault: hasAccounts === 0, ...data },
    });
  }

  async listAccounts(userId: string) {
    return this.prisma.bankAccount.findMany({ where: { userId } });
  }

  async getAccount(id: string) {
    return this.prisma.bankAccount.findUnique({ where: { id } });
  }

  async updateAccount(id: string, userId: string, data: {
    holderName?: string;
    bankName?: string;
    bankCode?: string;
    accountType?: string;
  }) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');

    return this.prisma.bankAccount.update({
      where: { id },
      data,
    });
  }

  async setDefault(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');

    await this.prisma.bankAccount.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
    return this.prisma.bankAccount.update({
      where: { id },
      data: { isDefault: true },
    });
  }

  async initiateVerification(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    if (acct.isVerified) throw new Error('already_verified');

    const amount1 = Math.floor(Math.random() * 99) + 1;
    const amount2 = Math.floor(Math.random() * 99) + 1;

    return this.prisma.bankAccount.update({
      where: { id },
      data: {
        metadata: {
          verificationStatus: 'pending',
          microDeposit1: amount1,
          microDeposit2: amount2,
          initiatedAt: new Date().toISOString(),
        },
      },
    });
  }

  async confirmVerification(id: string, userId: string, amount1: number, amount2: number) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    if (acct.isVerified) throw new Error('already_verified');

    const meta = acct.metadata as Record<string, unknown> | null;
    if (!meta || meta.verificationStatus !== 'pending') throw new Error('verification_not_initiated');

    const expected1 = meta.microDeposit1 as number;
    const expected2 = meta.microDeposit2 as number;

    if (amount1 !== expected1 || amount2 !== expected2) {
      throw new Error('amounts_mismatch');
    }

    return this.prisma.bankAccount.update({
      where: { id },
      data: {
        isVerified: true,
        metadata: { ...meta, verificationStatus: 'confirmed', confirmedAt: new Date().toISOString() },
      },
    });
  }

  async verify(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    if (acct.isVerified) throw new Error('already_verified');

    return this.prisma.bankAccount.update({
      where: { id },
      data: { isVerified: true },
    });
  }

  async getVerificationOverview(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });
    const byRail: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let verified = 0;
    let unverified = 0;

    for (const a of accounts) {
      byRail[a.rail] = (byRail[a.rail] ?? 0) + 1;
      byCountry[a.country] = (byCountry[a.country] ?? 0) + 1;
      if (a.isVerified) verified++;
      else unverified++;
    }

    return {
      totalAccounts: accounts.length,
      verified,
      unverified,
      verificationRate: accounts.length > 0 ? Math.round((verified / accounts.length) * 100) : 0,
      byRail,
      byCountry,
    };
  }

  async getPayoutReadiness(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    const readyAccounts: Array<{ id: string; bankName: string; rail: string; country: string; currency: string }> = [];
    const pendingAccounts: Array<{ id: string; bankName: string; reason: string }> = [];

    for (const a of accounts) {
      if (a.isVerified) {
        readyAccounts.push({ id: a.id, bankName: a.bankName, rail: a.rail, country: a.country, currency: a.currency });
      } else {
        pendingAccounts.push({ id: a.id, bankName: a.bankName, reason: 'not_verified' });
      }
    }

    const countryCoverage = [...new Set(readyAccounts.map((a) => a.country))];
    const railCoverage = [...new Set(readyAccounts.map((a) => a.rail))];

    return {
      totalAccounts: accounts.length,
      readyCount: readyAccounts.length,
      pendingCount: pendingAccounts.length,
      readyAccounts,
      pendingAccounts,
      countryCoverage,
      railCoverage,
    };
  }

  async getCoverageAnalysis(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    const byCountry: Record<string, { rails: string[]; currencies: string[]; verifiedCount: number; totalCount: number }> = {};
    const byRail: Record<string, { countries: string[]; count: number; verifiedCount: number }> = {};

    for (const a of accounts) {
      if (!byCountry[a.country]) byCountry[a.country] = { rails: [], currencies: [], verifiedCount: 0, totalCount: 0 };
      const countryEntry = byCountry[a.country];
      countryEntry.totalCount++;
      if (a.isVerified) countryEntry.verifiedCount++;
      if (!countryEntry.rails.includes(a.rail)) countryEntry.rails.push(a.rail);
      if (!countryEntry.currencies.includes(a.currency)) countryEntry.currencies.push(a.currency);

      if (!byRail[a.rail]) byRail[a.rail] = { countries: [], count: 0, verifiedCount: 0 };
      const railEntry = byRail[a.rail];
      railEntry.count++;
      if (a.isVerified) railEntry.verifiedCount++;
      if (!railEntry.countries.includes(a.country)) railEntry.countries.push(a.country);
    }

    const recommendations: string[] = [];
    const verifiedCount = accounts.filter((a: any) => a.isVerified).length;
    const unverifiedCount = accounts.length - verifiedCount;

    if (unverifiedCount > 0) recommendations.push(`${unverifiedCount} account(s) need verification`);
    if (Object.keys(byCountry).length === 1 && accounts.length > 0) recommendations.push('Consider adding accounts in other countries for broader coverage');
    if (Object.keys(byRail).length === 1 && accounts.length > 0) recommendations.push('Consider diversifying payment rails');

    const hasDefault = accounts.some((a: any) => a.isDefault);
    if (accounts.length > 0 && !hasDefault) recommendations.push('Set a default bank account');

    return {
      totalAccounts: accounts.length,
      verifiedCount,
      unverifiedCount,
      countryCoverage: Object.keys(byCountry).length,
      railCoverage: Object.keys(byRail).length,
      byCountry,
      byRail,
      recommendations,
    };
  }

  async getRailDistribution(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        byRail: [] as Array<{ rail: string; count: number; sharePercent: number; verifiedCount: number; countries: string[] }>,
        byCountry: [] as Array<{ country: string; count: number; sharePercent: number; rails: string[] }>,
        diversificationScore: 0,
        primaryRail: null as string | null,
        primaryCountry: null as string | null,
      };
    }

    const railMap = new Map<string, { count: number; verified: number; countries: Set<string> }>();
    const countryMap = new Map<string, { count: number; rails: Set<string> }>();

    for (const a of accounts) {
      const r = railMap.get(a.rail) ?? { count: 0, verified: 0, countries: new Set<string>() };
      r.count++;
      if (a.isVerified) r.verified++;
      r.countries.add(a.country);
      railMap.set(a.rail, r);

      const c = countryMap.get(a.country) ?? { count: 0, rails: new Set<string>() };
      c.count++;
      c.rails.add(a.rail);
      countryMap.set(a.country, c);
    }

    const total = accounts.length;
    const byRail = Array.from(railMap.entries())
      .map(([rail, data]) => ({
        rail,
        count: data.count,
        sharePercent: Math.round((data.count / total) * 10000) / 100,
        verifiedCount: data.verified,
        countries: Array.from(data.countries),
      }))
      .sort((a, b) => b.count - a.count);

    const byCountry = Array.from(countryMap.entries())
      .map(([country, data]) => ({
        country,
        count: data.count,
        sharePercent: Math.round((data.count / total) * 10000) / 100,
        rails: Array.from(data.rails),
      }))
      .sort((a, b) => b.count - a.count);

    const hhi = byRail.reduce((sum, r) => sum + (r.sharePercent / 100) ** 2, 0);
    const diversificationScore = Math.round((1 - hhi) * 100);

    return {
      totalAccounts: total,
      byRail,
      byCountry,
      diversificationScore,
      primaryRail: byRail[0]?.rail ?? null,
      primaryCountry: byCountry[0]?.country ?? null,
    };
  }

  async getHealthCheck(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        healthScore: 0,
        rating: 'none' as const,
        issues: ['No bank accounts added'] as string[],
        checks: { hasDefault: false, verificationRate: 0, multiRail: false, multiCountry: false, multiCurrency: false },
      };
    }

    const hasDefault = accounts.some((a: any) => a.isDefault);
    const verifiedCount = accounts.filter((a: any) => a.isVerified).length;
    const verificationRate = Math.round((verifiedCount / accounts.length) * 100);
    const rails = new Set(accounts.map((a: any) => a.rail));
    const countries = new Set(accounts.map((a: any) => a.country));
    const currencies = new Set(accounts.map((a: any) => a.currency));
    const multiRail = rails.size > 1;
    const multiCountry = countries.size > 1;
    const multiCurrency = currencies.size > 1;

    const issues: string[] = [];
    let score = 100;

    if (!hasDefault) { score -= 15; issues.push('No default account set'); }
    if (verificationRate < 100) { score -= Math.round((100 - verificationRate) * 0.3); issues.push(`${accounts.length - verifiedCount} unverified account(s)`); }
    if (!multiRail && accounts.length > 1) { score -= 10; issues.push('All accounts use the same payment rail'); }
    if (!multiCountry && accounts.length > 1) { score -= 10; issues.push('All accounts in the same country'); }

    score = Math.max(0, score);
    const rating = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor';

    return {
      totalAccounts: accounts.length,
      healthScore: score,
      rating,
      issues,
      checks: { hasDefault, verificationRate, multiRail, multiCountry, multiCurrency },
    };
  }

  async removeAccount(id: string, userId: string) {
    const acct = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!acct) throw new Error('account_not_found');
    if (acct.userId !== userId) throw new Error('forbidden');
    return this.prisma.bankAccount.delete({ where: { id } });
  }

  async getRedundancyAnalysis(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        redundantGroups: [],
        redundantCount: 0,
        uniqueCount: 0,
        recommendation: 'No bank accounts found.',
      };
    }

    const groups = new Map<string, typeof accounts>();
    for (const acct of accounts) {
      const key = `${(acct.bankName ?? '').toLowerCase()}_${(acct.currency ?? '').toLowerCase()}`;
      const list = groups.get(key) ?? [];
      list.push(acct);
      groups.set(key, list);
    }

    const redundantGroups = Array.from(groups.entries())
      .filter(([, accts]) => accts.length > 1)
      .map(([, accts]) => ({
        bankName: accts[0].bankName ?? 'Unknown',
        currency: accts[0].currency ?? 'Unknown',
        count: accts.length,
        accounts: accts.map((a) => ({
          id: a.id,
          holderName: a.holderName,
          accountType: a.accountType,
          isDefault: a.isDefault,
          verified: a.verified,
        })),
      }))
      .sort((a, b) => b.count - a.count);

    const redundantCount = redundantGroups.reduce((s, g) => s + g.count - 1, 0);
    const uniqueCount = accounts.length - redundantCount;

    let recommendation: string;
    if (redundantCount === 0) {
      recommendation = 'No redundant accounts detected.';
    } else if (redundantCount <= 2) {
      recommendation = 'A few accounts share the same bank and currency. Consider consolidating.';
    } else {
      recommendation = 'Multiple redundant accounts found. Consolidating could simplify management.';
    }

    return {
      totalAccounts: accounts.length,
      redundantGroups,
      redundantCount,
      uniqueCount,
      recommendation,
    };
  }

  async getAccountAgingReport(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        avgAgeDays: 0,
        oldestAgeDays: 0,
        newestAgeDays: 0,
        staleCount: 0,
        byAgeGroup: [],
        recommendation: 'No bank accounts found.',
      };
    }

    const now = Date.now();
    const ages = accounts.map((a: any) => ({
      id: a.id,
      bankName: a.bankName,
      ageDays: Math.floor((now - new Date(a.createdAt).getTime()) / 86400000),
      isVerified: !!(a.isVerified ?? a.verified),
      currency: a.currency,
    }));

    ages.sort((a, b) => b.ageDays - a.ageDays);

    const totalAge = ages.reduce((s, a) => s + a.ageDays, 0);
    const avgAgeDays = Math.round(totalAge / ages.length);
    const oldestAgeDays = ages[0].ageDays;
    const newestAgeDays = ages[ages.length - 1].ageDays;

    const staleThreshold = 180;
    const staleAccounts = ages.filter(a => a.ageDays > staleThreshold && !a.isVerified);

    const groups = [
      { label: 'new', min: 0, max: 30 },
      { label: 'recent', min: 30, max: 90 },
      { label: 'established', min: 90, max: 365 },
      { label: 'mature', min: 365, max: Infinity },
    ];

    const byAgeGroup = groups.map(g => ({
      group: g.label,
      count: ages.filter(a => a.ageDays >= g.min && a.ageDays < g.max).length,
    }));

    let recommendation: string;
    if (staleAccounts.length > 0) {
      recommendation = `${staleAccounts.length} unverified account(s) older than ${staleThreshold} days should be verified or removed.`;
    } else if (avgAgeDays > 365) {
      recommendation = 'All accounts are well-established. Consider reviewing for updated details.';
    } else {
      recommendation = 'Account portfolio is healthy with no stale entries.';
    }

    return {
      totalAccounts: accounts.length,
      avgAgeDays,
      oldestAgeDays,
      newestAgeDays,
      staleCount: staleAccounts.length,
      byAgeGroup,
      recommendation,
    };
  }

  async getAccountUtilizationReport(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        activelyUsed: 0,
        underutilized: 0,
        dormant: 0,
        utilizationRate: 0,
        byAccount: [],
      };
    }

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86400000;
    const ninetyDaysAgo = now - 90 * 86400000;

    const byAccount: { accountId: string; bankName: string; currency: string; status: string; utilizationLevel: string }[] = [];
    let activelyUsed = 0;
    let underutilized = 0;
    let dormant = 0;

    for (const acct of accounts) {
      const lastActivity = (acct as any).updatedAt || acct.createdAt;
      const lastMs = new Date(lastActivity).getTime();
      const verified = (acct as any).verified || (acct as any).status === 'verified';

      let utilizationLevel: string;
      if (lastMs >= thirtyDaysAgo && verified) {
        utilizationLevel = 'active';
        activelyUsed++;
      } else if (lastMs >= ninetyDaysAgo) {
        utilizationLevel = 'underutilized';
        underutilized++;
      } else {
        utilizationLevel = 'dormant';
        dormant++;
      }

      byAccount.push({
        accountId: acct.id,
        bankName: (acct as any).bankName || 'Unknown',
        currency: (acct as any).currency || 'USD',
        status: (acct as any).status || (verified ? 'verified' : 'unverified'),
        utilizationLevel,
      });
    }

    const utilizationRate = Math.round((activelyUsed / accounts.length) * 10000) / 100;

    return {
      totalAccounts: accounts.length,
      activelyUsed,
      underutilized,
      dormant,
      utilizationRate,
      byAccount,
    };
  }

  async getAccountConsolidationAdvice(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        canConsolidate: false,
        duplicateCurrencies: [],
        recommendations: [],
      };
    }

    const byCurrency: Record<string, Array<{ id: string; bankName: string; isDefault: boolean; verified: boolean }>> = {};
    for (const acct of accounts) {
      const curr = (acct as any).currency || 'USD';
      if (!byCurrency[curr]) byCurrency[curr] = [];
      byCurrency[curr].push({
        id: acct.id,
        bankName: (acct as any).bankName || 'Unknown',
        isDefault: (acct as any).isDefault ?? false,
        verified: (acct as any).verified ?? (acct as any).status === 'verified',
      });
    }

    const duplicateCurrencies: Array<{ currency: string; count: number; accounts: Array<{ id: string; bankName: string; isDefault: boolean }> }> = [];
    const recommendations: string[] = [];

    for (const [currency, accts] of Object.entries(byCurrency)) {
      if (accts.length > 1) {
        duplicateCurrencies.push({
          currency,
          count: accts.length,
          accounts: accts.map(a => ({ id: a.id, bankName: a.bankName, isDefault: a.isDefault })),
        });
      }
    }

    if (duplicateCurrencies.length > 0) {
      recommendations.push(`${duplicateCurrencies.length} currency(ies) have multiple accounts — consider consolidating`);
    }

    const unverified = accounts.filter(a => !(a as any).verified && (a as any).status !== 'verified');
    if (unverified.length > 0) {
      recommendations.push(`${unverified.length} unverified account(s) — verify or remove`);
    }

    const noDefault = Object.entries(byCurrency).filter(([, accts]) => !accts.some(a => a.isDefault));
    if (noDefault.length > 0) {
      recommendations.push(`${noDefault.length} currency(ies) have no default account set`);
    }

    return {
      totalAccounts: accounts.length,
      canConsolidate: duplicateCurrencies.length > 0,
      duplicateCurrencies,
      recommendations,
    };
  }

  async getAccountSecurityAudit(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        securityScore: 100,
        securityLevel: 'none' as const,
        findings: [] as { accountId: string; finding: string; severity: 'high' | 'medium' | 'low' }[],
        recommendations: [] as string[],
      };
    }

    const findings: { accountId: string; finding: string; severity: 'high' | 'medium' | 'low' }[] = [];

    for (const a of accounts) {
      const verified = (a as any).verified || (a as any).status === 'verified';
      if (!verified) {
        findings.push({ accountId: a.id, finding: 'Account not verified', severity: 'high' });
      }

      const age = Date.now() - new Date(a.createdAt).getTime();
      if (age > 365 * 86400000 && !verified) {
        findings.push({ accountId: a.id, finding: 'Unverified account older than 1 year', severity: 'high' });
      }

      if (!(a as any).bankName && !(a as any).bankCode) {
        findings.push({ accountId: a.id, finding: 'Missing bank identification details', severity: 'medium' });
      }

      if (!(a as any).holderName) {
        findings.push({ accountId: a.id, finding: 'Missing account holder name', severity: 'medium' });
      }
    }

    const highCount = findings.filter(f => f.severity === 'high').length;
    const mediumCount = findings.filter(f => f.severity === 'medium').length;
    const securityScore = Math.max(0, 100 - highCount * 25 - mediumCount * 10);
    const securityLevel = securityScore >= 80 ? 'good' as const
      : securityScore >= 50 ? 'fair' as const
      : 'poor' as const;

    const recommendations: string[] = [];
    if (highCount > 0) recommendations.push('Address high-severity findings to secure your bank accounts');
    const unverifiedCount = findings.filter(f => f.finding.includes('not verified')).length;
    if (unverifiedCount > 0) recommendations.push(`Verify ${unverifiedCount} unverified account(s)`);
    if (findings.length === 0) recommendations.push('All accounts pass security audit');

    return {
      totalAccounts: accounts.length,
      securityScore,
      securityLevel,
      findings,
      recommendations,
    };
  }

  async getAccountDormancyRisk(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        dormantCount: 0,
        atRiskCount: 0,
        dormancyRate: 0,
        riskLevel: 'no_data',
        accounts: [],
        recommendations: [],
      };
    }

    const now = Date.now();
    const accountAnalysis: Array<{ id: string; bankName: string; daysSinceActivity: number | null; dormancyStatus: string }> = [];
    let dormantCount = 0;
    let atRiskCount = 0;

    for (const a of accounts) {
      const lastUsed = (a as any).lastUsedAt || (a as any).updatedAt || (a as any).createdAt;
      const daysSinceActivity = lastUsed ? Math.round((now - new Date(lastUsed).getTime()) / 86400000) : null;
      let dormancyStatus = 'active';

      if (daysSinceActivity !== null) {
        if (daysSinceActivity > 180) { dormancyStatus = 'dormant'; dormantCount++; }
        else if (daysSinceActivity > 90) { dormancyStatus = 'at_risk'; atRiskCount++; }
      }

      accountAnalysis.push({
        id: a.id,
        bankName: (a as any).bankName || (a as any).institutionName || 'Unknown',
        daysSinceActivity,
        dormancyStatus,
      });
    }

    const dormancyRate = Math.round((dormantCount / accounts.length) * 10000) / 100;
    const riskLevel = dormantCount > accounts.length * 0.5 ? 'high'
      : (dormantCount + atRiskCount) > 0 ? 'moderate' : 'low';

    const recommendations: string[] = [];
    if (dormantCount > 0) recommendations.push(`${dormantCount} account(s) dormant for 180+ days — consider removal`);
    if (atRiskCount > 0) recommendations.push(`${atRiskCount} account(s) approaching dormancy — use or verify`);
    if (riskLevel === 'low') recommendations.push('All accounts are actively used');

    return {
      totalAccounts: accounts.length,
      dormantCount,
      atRiskCount,
      dormancyRate,
      riskLevel,
      accounts: accountAnalysis,
      recommendations,
    };
  }

  async getAccountRecoveryReadiness(userId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { userId } });

    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        readinessScore: 0,
        readinessLevel: 'no_data' as const,
        checks: [],
        recommendations: [] as string[],
      };
    }

    const checks: { check: string; passed: boolean; severity: string }[] = [];

    const verifiedCount = accounts.filter((a: any) => a.verified).length;
    checks.push({ check: 'verified_accounts', passed: verifiedCount > 0, severity: 'high' });

    const hasDefault = accounts.some((a: any) => a.isDefault);
    checks.push({ check: 'default_account_set', passed: hasDefault, severity: 'medium' });

    const multipleAccounts = accounts.length >= 2;
    checks.push({ check: 'backup_account_available', passed: multipleAccounts, severity: 'high' });

    const uniqueBanks = new Set(accounts.map((a: any) => a.bankName ?? a.routingNumber ?? 'unknown'));
    checks.push({ check: 'multi_bank_diversity', passed: uniqueBanks.size >= 2, severity: 'medium' });

    const recentAccount = accounts.some((a: any) => {
      const created = new Date(a.createdAt ?? Date.now());
      return (Date.now() - created.getTime()) < 180 * 86400000;
    });
    checks.push({ check: 'recently_updated', passed: recentAccount, severity: 'low' });

    const passedCount = checks.filter(c => c.passed).length;
    let readinessScore = Math.round((passedCount / checks.length) * 100);
    const highFailures = checks.filter(c => !c.passed && c.severity === 'high').length;
    if (highFailures > 0) readinessScore = Math.max(0, readinessScore - highFailures * 10);

    const readinessLevel = readinessScore >= 80 ? 'ready'
      : readinessScore >= 50 ? 'partial' : 'not_ready';

    const recommendations: string[] = [];
    if (!hasDefault) recommendations.push('Set a default bank account for fallback withdrawals');
    if (!multipleAccounts) recommendations.push('Add a backup bank account for redundancy');
    if (verifiedCount === 0) recommendations.push('Verify at least one bank account');
    if (readinessLevel === 'ready') recommendations.push('Account recovery setup is solid');

    return {
      totalAccounts: accounts.length,
      readinessScore,
      readinessLevel,
      passedChecks: passedCount,
      totalChecks: checks.length,
      checks,
      recommendations,
    };
  }
}
