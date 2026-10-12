import type { PrismaClient } from '@prisma/client';

const DEFAULT_RATES: Record<string, Record<string, { bid: number; ask: number }>> = {
  USD: {
    PEN: { bid: 3.72, ask: 3.75 },
    MXN: { bid: 17.05, ask: 17.15 },
    BRL: { bid: 4.95, ask: 5.02 },
    CLP: { bid: 880, ask: 890 },
    COP: { bid: 3950, ask: 3990 },
    ARS: { bid: 890, ask: 920 },
    EUR: { bid: 0.915, ask: 0.925 },
    GBP: { bid: 0.79, ask: 0.80 },
    SGD: { bid: 1.34, ask: 1.36 },
    AUD: { bid: 1.53, ask: 1.55 },
    INR: { bid: 83.0, ask: 83.8 },
    CNY: { bid: 7.20, ask: 7.28 },
    JPY: { bid: 148.5, ask: 150.0 },
  },
};

export class FxService {
  constructor(private prisma: PrismaClient) {}

  async getRate(baseCurrency: string, quoteCurrency: string) {
    const base = baseCurrency.toUpperCase();
    const quote = quoteCurrency.toUpperCase();

    if (base === quote) {
      return { baseCurrency: base, quoteCurrency: quote, bid: 1, ask: 1, mid: 1, spread: 0, spreadBps: 0, source: 'identity' };
    }

    // Check DB for fresh rate
    const dbRate = await this.prisma.fxRate.findFirst({
      where: {
        baseCurrency: base,
        quoteCurrency: quote,
        validFrom: { lte: new Date() },
        OR: [{ validTo: null }, { validTo: { gte: new Date() } }],
      },
      orderBy: { validFrom: 'desc' },
    });

    if (dbRate) {
      return {
        baseCurrency: base,
        quoteCurrency: quote,
        bid: dbRate.bid,
        ask: dbRate.ask,
        mid: dbRate.mid,
        spread: dbRate.spread,
        spreadBps: Math.round(dbRate.spread / dbRate.mid * 10000),
        source: dbRate.source,
        validFrom: dbRate.validFrom.toISOString(),
      };
    }

    // Fallback to defaults
    const directRate = DEFAULT_RATES[base]?.[quote];
    if (directRate) {
      const mid = (directRate.bid + directRate.ask) / 2;
      const spread = directRate.ask - directRate.bid;
      return {
        baseCurrency: base,
        quoteCurrency: quote,
        bid: directRate.bid,
        ask: directRate.ask,
        mid,
        spread,
        spreadBps: Math.round(spread / mid * 10000),
        source: 'default',
      };
    }

    // Try inverse
    const inverseRate = DEFAULT_RATES[quote]?.[base];
    if (inverseRate) {
      const bid = 1 / inverseRate.ask;
      const ask = 1 / inverseRate.bid;
      const mid = (bid + ask) / 2;
      const spread = ask - bid;
      return {
        baseCurrency: base,
        quoteCurrency: quote,
        bid: Number(bid.toFixed(6)),
        ask: Number(ask.toFixed(6)),
        mid: Number(mid.toFixed(6)),
        spread: Number(spread.toFixed(6)),
        spreadBps: Math.round(spread / mid * 10000),
        source: 'default_inverse',
      };
    }

    // Cross via USD
    const baseToUsd = DEFAULT_RATES['USD']?.[base];
    const quoteToUsd = DEFAULT_RATES['USD']?.[quote];
    if (baseToUsd && quoteToUsd) {
      const bid = quoteToUsd.bid / baseToUsd.ask;
      const ask = quoteToUsd.ask / baseToUsd.bid;
      const mid = (bid + ask) / 2;
      const spread = ask - bid;
      return {
        baseCurrency: base,
        quoteCurrency: quote,
        bid: Number(bid.toFixed(6)),
        ask: Number(ask.toFixed(6)),
        mid: Number(mid.toFixed(6)),
        spread: Number(spread.toFixed(6)),
        spreadBps: Math.round(spread / mid * 10000),
        source: 'cross_usd',
      };
    }

    return null;
  }

  async convert(
    amount: bigint,
    fromCurrency: string,
    toCurrency: string,
    side: 'buy' | 'sell' = 'buy',
  ) {
    const rate = await this.getRate(fromCurrency, toCurrency);
    if (!rate) throw new Error(`no_rate_available_${fromCurrency}_${toCurrency}`);

    const appliedRate = side === 'buy' ? rate.ask : rate.bid;
    const converted = BigInt(Math.round(Number(amount) * appliedRate));

    return {
      fromAmount: amount.toString(),
      fromCurrency: fromCurrency.toUpperCase(),
      toAmount: converted.toString(),
      toCurrency: toCurrency.toUpperCase(),
      rate: appliedRate,
      spreadBps: rate.spreadBps,
      source: rate.source,
    };
  }

  async getConversionHistory(userId: string) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId, type: 'FX_CONVERSION', status: 'COMPLETED' },
    });

    const byPair: Record<string, { count: number; totalSourceAmount: bigint; totalTargetAmount: bigint }> = {};

    for (const t of txns) {
      const src = (t as any).fxSourceCurrency ?? t.currency;
      const tgt = (t as any).fxTargetCurrency ?? '';
      const pair = `${src}/${tgt}`;
      if (!byPair[pair]) byPair[pair] = { count: 0, totalSourceAmount: BigInt(0), totalTargetAmount: BigInt(0) };
      byPair[pair].count++;
      byPair[pair].totalSourceAmount += (t as any).fxSourceAmount ?? BigInt(0);
      byPair[pair].totalTargetAmount += (t as any).fxTargetAmount ?? BigInt(0);
    }

    return { totalConversions: txns.length, byPair };
  }

  async getSupportedPairs() {
    const pairs: string[] = [];
    for (const [base, quotes] of Object.entries(DEFAULT_RATES)) {
      for (const quote of Object.keys(quotes)) {
        pairs.push(`${base}/${quote}`);
      }
    }
    return pairs;
  }

  async getBulkRates(pairs: Array<{ base: string; quote: string }>) {
    const results: Array<any> = [];
    for (const pair of pairs) {
      const rate = await this.getRate(pair.base, pair.quote);
      if (rate) {
        results.push(rate);
      } else {
        results.push({ baseCurrency: pair.base.toUpperCase(), quoteCurrency: pair.quote.toUpperCase(), error: 'rate_not_available' });
      }
    }
    return results;
  }

  async getRateHistory(baseCurrency: string, quoteCurrency: string, opts?: { limit?: number }) {
    const base = baseCurrency.toUpperCase();
    const quote = quoteCurrency.toUpperCase();
    return this.prisma.fxRate.findMany({
      where: { baseCurrency: base, quoteCurrency: quote },
      orderBy: { validFrom: 'desc' },
      take: Math.min(opts?.limit ?? 20, 100),
    });
  }

  async getSpreadAnalysis(userId: string) {
    const txns = await this.prisma.transaction.findMany({
      where: { userId, type: 'FX_CONVERSION', status: 'COMPLETED' },
    });

    if (txns.length === 0) {
      return { totalConversions: 0, avgSpreadBps: 0, totalVolume: BigInt(0), byPair: {}, bestRate: null, worstRate: null };
    }

    const byPair: Record<string, { count: number; totalVolume: bigint; rates: number[] }> = {};
    let bestRate: { pair: string; rate: number } | null = null;
    let worstRate: { pair: string; rate: number } | null = null;

    for (const t of txns) {
      const src = (t as any).fxSourceCurrency ?? t.currency;
      const tgt = (t as any).fxTargetCurrency ?? '';
      const pair = `${src}/${tgt}`;
      const rate = (t as any).fxRate ?? 0;

      if (!byPair[pair]) byPair[pair] = { count: 0, totalVolume: BigInt(0), rates: [] };
      byPair[pair].count++;
      byPair[pair].totalVolume += (t as any).fxSourceAmount ?? BigInt(0);
      if (rate > 0) byPair[pair].rates.push(rate);

      if (rate > 0) {
        if (!bestRate || rate > bestRate.rate) bestRate = { pair, rate };
        if (!worstRate || rate < worstRate.rate) worstRate = { pair, rate };
      }
    }

    let totalVolume = BigInt(0);
    const pairSummary: Record<string, { count: number; totalVolume: bigint; avgRate: number }> = {};
    for (const [pair, data] of Object.entries(byPair)) {
      totalVolume += data.totalVolume;
      const avgRate = data.rates.length > 0
        ? Math.round((data.rates.reduce((s, r) => s + r, 0) / data.rates.length) * 1e6) / 1e6
        : 0;
      pairSummary[pair] = { count: data.count, totalVolume: data.totalVolume, avgRate };
    }

    return { totalConversions: txns.length, totalVolume, byPair: pairSummary, bestRate, worstRate };
  }

  async storeRate(baseCurrency: string, quoteCurrency: string, bid: number, ask: number, source: string) {
    const mid = (bid + ask) / 2;
    const spread = ask - bid;
    return this.prisma.fxRate.create({
      data: {
        baseCurrency: baseCurrency.toUpperCase(),
        quoteCurrency: quoteCurrency.toUpperCase(),
        bid,
        ask,
        mid,
        spread,
        source,
        validFrom: new Date(),
      },
    });
  }
}
