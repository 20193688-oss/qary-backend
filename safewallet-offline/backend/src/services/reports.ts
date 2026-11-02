import type { Ctx, LogRecord } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { sha256Hex } from '../util/crypto.js';
import { badRequest } from '../util/errors.js';
import type { Profile, Tenant } from '../types.js';
import { getDevice, getProfile } from './devices.js';
import { txHistory } from './payments.js';

export const PERIODS = { hourly: 3600_000, daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000, yearly: 365 * 86_400_000 } as const;
export type Period = keyof typeof PERIODS;

export async function generateReport(ctx: Ctx, tenant: Tenant, deviceId: string, period: Period) {
  if (!(period in PERIODS)) throw badRequest('bad_period', 'periodo inválido');
  const d = await getDevice(ctx, deviceId, tenant);
  const to = ctx.now(); const from = to - PERIODS[period];
  const txs = (await txHistory(ctx, tenant, d.id)).filter((t) => t.settledAt >= from && t.settledAt <= to);
  const out: Record<string, number> = {}; const inc: Record<string, number> = {}; let fxAdj = 0; let maxRisk = 0;
  for (const t of txs) {
    if (t.payerDeviceId === d.id) { out[t.payerCurrency] = (out[t.payerCurrency] ?? 0) + t.finalPayerAmountMinor; fxAdj += t.fx.adjustmentMinor; maxRisk = Math.max(maxRisk, t.riskScore); }
    else inc[t.currency] = (inc[t.currency] ?? 0) + t.amountMinor;
  }
  const events = (await ctx.store.list<LogRecord>(`log:dev:${d.id}`, 100000)).filter((r) => r.ts >= from && ['violation', 'shield', 'ledger_rejected', 'status_change'].includes(r.type));
  const body = {
    deviceId: d.id, period, from, to, status: d.status, txCount: txs.length, outgoingMinor: out, incomingMinor: inc,
    fxAdjustmentMinor: fxAdj, maxRiskScore: maxRisk, securityEvents: events.map((e) => ({ type: e.type, ts: e.ts })),
  };
  const hash = sha256Hex(canonical(body));
  const rec = await ctx.appendLog(`reports:${d.id}`, 'report', { period, hash, from, to });
  const report = { ...body, hash, sig: ctx.signServer(hash), logIndex: rec.index, logHash: rec.hash };
  const prof = await getProfile(ctx, d.id);
  if (prof.email) await ctx.enqueue({ kind: 'email', to: prof.email, deviceId: d.id, tenantId: d.tenantId, body: `Informe ${period} SafeWallet — hash ${hash} — ${txs.length} operaciones.` });
  return report;
}

/** Genera informes vencidos para todos los perfiles con email (periodicidad hourly..yearly). */
export async function sweepReports(ctx: Ctx): Promise<number> {
  let n = 0;
  for (const p of await ctx.store.list<Profile>('profiles', 100000)) {
    if (!p.email) continue;
    const d = await ctx.store.get<{ id: string; tenantId: string }>('devices', p.deviceId);
    if (!d) continue;
    for (const period of Object.keys(PERIODS) as Period[]) {
      const key = `report_last:${p.deviceId}:${period}`;
      const last = Number((await ctx.kv.get(key)) ?? '0');
      if (ctx.now() - last >= PERIODS[period]) {
        await generateReport(ctx, { id: d.tenantId, admin: true } as Tenant, p.deviceId, period);
        await ctx.kv.set(key, String(ctx.now()), Math.ceil(PERIODS[period] / 1000) + 3600);
        n++;
      }
    }
  }
  return n;
}
