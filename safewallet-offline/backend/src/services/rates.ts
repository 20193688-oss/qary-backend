import type { Ctx } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { ecdsaVerify, sha256Hex } from '../util/crypto.js';
import { badRequest, notFound } from '../util/errors.js';
import { CURRENCIES, type Currency } from '../types.js';

export interface RateSnapshot {
  id: string; base: 'USD'; asOf: number; expiresAt: number;
  ratesMicros: Record<Currency, number>;   // unidades de moneda por 1 USD, x1e6
  marginBps: number; source: string; sig: string;
  [k: string]: unknown;
}

/** Tasas de referencia estáticas (fallback cuando no hay fuente en vivo). Ajustables vía POST /v1/rates (admin). */
export const REFERENCE_RATES_MICROS: Record<Currency, number> = {
  USD: 1_000_000, PEN: 3_750_000, EUR: 920_000, CRC: 520_000_000, VES: 36_500_000, COP: 4_000_000_000,
};

const body = (s: Omit<RateSnapshot, 'sig'>): string => canonical({ id: s.id, base: s.base, asOf: s.asOf, expiresAt: s.expiresAt, ratesMicros: s.ratesMicros, marginBps: s.marginBps, source: s.source });

export async function publishRates(ctx: Ctx, rates: Partial<Record<Currency, number>>, source: string, ttlHours = 24): Promise<RateSnapshot> {
  const merged = { ...REFERENCE_RATES_MICROS, ...(await latestRates(ctx).then((s) => s?.ratesMicros).catch(() => undefined)), ...rates } as Record<Currency, number>;
  for (const c of CURRENCIES) {
    const v = merged[c];
    if (!Number.isSafeInteger(v) || v <= 0) throw badRequest('bad_rate', `tasa inválida para ${c}`);
  }
  merged.USD = 1_000_000;
  const asOf = ctx.now();
  const id = `rs_${asOf}_${sha256Hex(canonical(merged)).slice(0, 6)}`;
  const base: Omit<RateSnapshot, 'sig'> = { id, base: 'USD', asOf, expiresAt: asOf + ttlHours * 3600_000, ratesMicros: merged, marginBps: ctx.cfg.rateMarginBps, source };
  const snap: RateSnapshot = { ...base, sig: ctx.signServer(body(base)) } as RateSnapshot;
  await ctx.store.put('rates', id, snap);
  await ctx.store.put('rates_latest', 'latest', { id });
  return snap;
}

export async function latestRates(ctx: Ctx): Promise<RateSnapshot | undefined> {
  const p = await ctx.store.get<{ id: string }>('rates_latest', 'latest');
  return p ? ctx.store.get<RateSnapshot>('rates', p.id) : undefined;
}

/** Devuelve el snapshot vigente; si no existe, venció o su firma no verifica con la clave actual (rotación de clave), publica uno nuevo. */
export async function ensureRates(ctx: Ctx): Promise<RateSnapshot> {
  const cur = await latestRates(ctx);
  if (cur && cur.expiresAt > ctx.now() && verifySnapshot(cur, ctx.secrets.server.publicKey)) return cur;
  if (cur) ctx.log.warn({ snapshot: cur.id }, 'snapshot de tasas vencido o con firma inválida: se publica uno nuevo');
  return publishRates(ctx, {}, 'reference-static');
}

export async function getSnapshot(ctx: Ctx, id: string): Promise<RateSnapshot> {
  const s = await ctx.store.get<RateSnapshot>('rates', id);
  if (!s) throw notFound('rate_snapshot_unknown', `snapshot de tasas desconocido: ${id}`);
  return s;
}

export function verifySnapshot(s: RateSnapshot, serverPub: string): boolean {
  return ecdsaVerify(serverPub, body(s), s.sig);
}

/** Unidades de `dst` por 1 `src`, x1e6 (redondeo al más cercano). */
export function crossRateMicros(s: Pick<RateSnapshot, 'ratesMicros'>, src: Currency, dst: Currency): number {
  const r = (BigInt(s.ratesMicros[dst]) * 1_000_000n * 2n + BigInt(s.ratesMicros[src])) / (BigInt(s.ratesMicros[src]) * 2n);
  return Number(r);
}

/** Precio en moneda del pagador de `destMinor` aplicando margen de seguridad (redondeo hacia arriba). */
export function payerPriceMinor(destMinor: number, rateMicros: number, marginBps: number): number {
  const num = BigInt(destMinor) * 1_000_000n * BigInt(10_000 + marginBps);
  const den = BigInt(rateMicros) * 10_000n;
  return Number((num + den - 1n) / den);
}

/** Precio justo (sin margen) en moneda del pagador, redondeo hacia arriba. */
export function fairPriceMinor(destMinor: number, rateMicros: number): number { return payerPriceMinor(destMinor, rateMicros, 0); }

export function toUsdMinor(s: Pick<RateSnapshot, 'ratesMicros'>, c: Currency, minor: number): number {
  return Number((BigInt(minor) * 1_000_000n + BigInt(s.ratesMicros[c]) / 2n) / BigInt(s.ratesMicros[c]));
}

export interface RateSource { name: string; fetch(): Promise<Partial<Record<Currency, number>>> }

export const staticReferenceSource: RateSource = { name: 'reference-static', fetch: async () => ({ ...REFERENCE_RATES_MICROS }) };

/** BCE (ECB) diario: da EUR por USD. Si falla, el llamador cae a la fuente de referencia. */
export const ecbSource = (fetchFn: typeof fetch = fetch): RateSource => ({
  name: 'ecb',
  async fetch() {
    const res = await fetchFn('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
    const m = /currency='USD'\s+rate='([0-9.]+)'/.exec(await res.text());
    if (!m) throw new Error('ECB: USD no encontrado');
    const eurPerUsd = 1 / Number(m[1]);
    return { EUR: Math.round(eurPerUsd * 1_000_000) };
  },
});

/** Intenta cada fuente en orden; la primera que responde gana, la última es el fallback. */
export async function refreshRates(ctx: Ctx, sources: RateSource[]): Promise<RateSnapshot> {
  for (const s of sources) {
    try { return await publishRates(ctx, await s.fetch(), s.name); } catch (e) { ctx.log.warn({ source: s.name, err: (e as Error).message }, 'fuente de tasas no disponible'); }
  }
  return publishRates(ctx, {}, 'reference-static');
}
