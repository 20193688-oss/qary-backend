import type { Ctx } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { ecdsaVerify, GENESIS_HASH, hmacHex, safeEqualHex, sha256Hex } from '../util/crypto.js';
import { badRequest } from '../util/errors.js';
import { CURRENCIES, type Device, type Intent, type LedgerEntry, type Tenant, type Voucher } from '../types.js';
import { getDevice, getProfile, ledgerKey, lukFor, saveDevice, setStatus, smsKey } from './devices.js';
import { computeArqc, type Token } from './tokenization.js';
import { crossRateMicros, fairPriceMinor, getSnapshot, payerPriceMinor, toUsdMinor } from './rates.js';
import { riskScore } from './risk.js';
import { activeRiskFlag } from './panic.js';
import { consumeQr } from './qr-interop.js';

export type TxStatus = 'settled' | 'duplicate' | 'declined' | 'rejected';
export interface TxResult {
  txId: string; status: TxStatus; reason?: string; riskScore?: number; stepUpRequired?: string[]; violation?: string;
  fx?: { agreedRateMicros: number; fairRateMicros: number; adjustmentMinor: number; favors: 'user' | 'merchant' | 'none' };
}
export interface TxRecord {
  txId: string; payerDeviceId: string; payeeDeviceId?: string; payeeRef?: string; amountMinor: number; currency: string;
  payerAmountMinor: number; payerCurrency: string; finalPayerAmountMinor: number; usdMinor: number; channel: string;
  ts: number; settledAt: number; day: string; riskScore: number; intentHash: string; via: string;
  fx: NonNullable<TxResult['fx']>; fxStatus: 'reconciled'; status: 'settled';
  [k: string]: unknown;
}
export interface Wallet { deviceId: string; balances: Record<string, number>; [k: string]: unknown }

const SKEW_MS = 5 * 60_000;
const VIOLATIONS = new Set(['double_spend', 'counter_reuse', 'token_reuse', 'rate_tampering', 'limit_exceeded']);
const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
export const intentHash = (i: Intent): string => sha256Hex(canonical(i));

export async function fund(ctx: Ctx, tenant: Tenant, deviceId: string, currency: string, amountMinor: number): Promise<Wallet> {
  const d = await getDevice(ctx, deviceId, tenant);
  if (!CURRENCIES.includes(currency as never)) throw badRequest('invalid_currency', 'moneda no soportada');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw badRequest('invalid_amount', 'monto inválido');
  return ctx.lock(`wallet:${d.id}`, async () => {
    const w = (await ctx.store.get<Wallet>('wallets', d.id)) ?? { deviceId: d.id, balances: {} };
    w.balances[currency] = (w.balances[currency] ?? 0) + amountMinor;
    await ctx.store.put('wallets', d.id, w);
    await ctx.appendLog(`dev:${d.id}`, 'fund', { currency, amountMinor });
    return w;
  });
}

export async function getWallet(ctx: Ctx, deviceId: string, tenant: Tenant): Promise<Wallet> {
  await getDevice(ctx, deviceId, tenant);
  return (await ctx.store.get<Wallet>('wallets', deviceId)) ?? { deviceId, balances: {} };
}

async function violate(ctx: Ctx, payer: Device, kind: string, txId: string, extra: Record<string, unknown> = {}): Promise<string> {
  if (payer.status === 'active') {
    await setStatus(ctx, payer, 'locked', kind);
    const prof = await getProfile(ctx, payer.id);
    if (prof.phone) await ctx.enqueue({ kind: 'sms', to: prof.phone, deviceId: payer.id, tenantId: payer.tenantId, body: `SafeWallet: bloqueo preventivo por actividad sospechosa (${kind}). Confirma con tu PIN para reactivar.` });
  }
  await ctx.appendLog(`dev:${payer.id}`, 'violation', { kind, txId, ...extra });
  await ctx.emit(payer.tenantId, 'fraud.' + kind, { deviceId: payer.id, txId, ...extra });
  return kind;
}

/** Valida y liquida un voucher offline. Idempotente por txId. Serializa por pagador para evitar carreras de doble gasto. */
export interface ProcessOpts { preAuthenticated?: boolean }
export async function processVoucher(ctx: Ctx, v: Voucher, via: string, opts: ProcessOpts = {}): Promise<TxResult> {
  const i = v.intent;
  if (!i || typeof i.txId !== 'string' || !/^[0-9a-f]{8,64}$/.test(i.txId)) return { txId: String(i?.txId ?? ''), status: 'rejected', reason: 'bad_tx_id' };
  try { canonical(i); } catch { return { txId: i.txId, status: 'rejected', reason: 'intent_not_canonical' }; } // solo enteros: coordenadas en microgrados (latE6/lonE6)
  return ctx.lock(`payer:${i.payerDeviceId}`, () => processLocked(ctx, v, via, opts));
}

async function processLocked(ctx: Ctx, v: Voucher, via: string, opts: ProcessOpts): Promise<TxResult> {
  const i = v.intent;
  const reject = (reason: string): TxResult => ({ txId: i.txId, status: 'rejected', reason });
  const decline = (reason: string, extra: Partial<TxResult> = {}): TxResult => ({ txId: i.txId, status: 'declined', reason, ...extra });

  const payer = await ctx.store.get<Device>('devices', i.payerDeviceId);
  if (!payer) return reject('payer_unknown');
  if (!opts.preAuthenticated && !ecdsaVerify(payer.publicKey, canonical(i), v.payerSig)) return reject('payer_signature_invalid');

  const prior = await ctx.store.get<TxRecord>('txs', i.txId);
  if (prior) {
    return prior.intentHash === intentHash(i)
      ? { txId: i.txId, status: 'duplicate', fx: prior.fx, riskScore: prior.riskScore }
      : reject('txid_conflict');
  }

  if (payer.status !== 'active') return decline(payer.status === 'shielded' ? 'device_shielded' : `device_${payer.status}`);
  if (!payer.trusted) return decline('device_untrusted');
  if (!Number.isSafeInteger(i.amountMinor) || i.amountMinor <= 0 || !Number.isSafeInteger(i.payerAmountMinor) || i.payerAmountMinor <= 0) return reject('invalid_amount');
  if (!CURRENCIES.includes(i.currency) || !CURRENCIES.includes(i.payerCurrency)) return reject('invalid_currency');
  if (!Number.isSafeInteger(i.counter) || i.counter < 1) return reject('invalid_counter');
  if (i.payeeDeviceId === i.payerDeviceId) return reject('self_payment');
  if (!i.payeeDeviceId && !i.payeeRef) return reject('no_payee');
  const now = ctx.now();
  if (i.ts > now + SKEW_MS) return reject('timestamp_in_future');
  if (now - i.ts > ctx.cfg.voucherMaxAgeMs) return decline('voucher_expired');
  if (i.keyEpoch < payer.minKeyEpoch) return decline('key_epoch_revoked');

  // --- tasa y precio (determinista y verificable)
  const snap = await ctx.store.get<Awaited<ReturnType<typeof getSnapshot>>>('rates', i.rateSnapshotId);
  if (!snap) return reject('rate_snapshot_unknown');
  if (i.ts > snap.expiresAt + 24 * 3600_000) return decline('rate_snapshot_stale');
  const expRate = i.currency === i.payerCurrency ? 1_000_000 : crossRateMicros(snap, i.payerCurrency, i.currency);
  const expPrice = payerPriceMinor(i.amountMinor, expRate, i.marginBps);
  if (i.rateMicros !== expRate || i.marginBps > snap.marginBps || i.marginBps < 0 || i.payerAmountMinor !== expPrice) {
    return decline('rate_tampering', { violation: await violate(ctx, payer, 'rate_tampering', i.txId) });
  }

  // --- token + ARQC
  const tok = await ctx.store.get<Token>('tokens', i.token);
  if (!tok || tok.deviceId !== payer.id) return reject('token_unknown');
  if (tok.status === 'revoked') return decline('token_revoked');
  if (tok.status === 'used' && tok.usedBy !== i.txId) return decline('token_reuse', { violation: await violate(ctx, payer, 'token_reuse', i.txId, { token: tok.token.slice(-4) }) });
  if (tok.expiresAt < i.ts) return decline('token_expired');
  const arqc = computeArqc(lukFor(ctx, payer.id, tok.token, tok.lukEpoch), { token: tok.token, amountMinor: i.amountMinor, currency: i.currency, counter: i.counter, txId: i.txId });
  if (!safeEqualHex(arqc, i.arqc)) return reject('arqc_invalid');

  // --- contador monotónico anti-replay
  const ctr = await ctx.store.get<{ txId: string }>('counters', `${payer.id}:${i.counter}`);
  if (ctr && ctr.txId !== i.txId) return decline('counter_reuse', { violation: await violate(ctx, payer, 'counter_reuse', i.txId, { counter: i.counter }) });

  if (i.channel === 'qr') {
    const qerr = await consumeQr(ctx, i);
    if (qerr) return decline(qerr);
  }

  // --- límites y riesgo
  const prof = await getProfile(ctx, payer.id);
  const usd = toUsdMinor(snap, i.payerCurrency, i.payerAmountMinor);
  const unlisted = !!i.merchantRef && !prof.whitelistMerchants.includes(i.merchantRef);
  const perTx = unlisted ? Math.floor(prof.offlinePerTxLimitUsdMinor / 4) : prof.offlinePerTxLimitUsdMinor;
  if (usd > perTx) return decline(unlisted ? 'merchant_not_whitelisted_limit' : 'per_tx_limit_exceeded');
  const country = i.geo?.country;
  if (country && prof.countryLimitsUsdMinor[country] !== undefined && usd > prof.countryLimitsUsdMinor[country]) return decline('country_limit_exceeded');
  const day = dayOf(i.ts);
  const history = (await ctx.store.find<TxRecord>('txs', { payerDeviceId: payer.id })).filter((t) => t.status === 'settled');
  const usedToday = history.filter((t) => t.day === day).reduce((a, t) => a + t.usdMinor, 0);
  if (usedToday + usd > prof.offlineDailyLimitUsdMinor) {
    return decline('daily_offline_limit_exceeded', { violation: await violate(ctx, payer, 'limit_exceeded', i.txId, { usedToday, usd }) });
  }
  const txLastHour = history.filter((t) => t.ts > i.ts - 3600_000 && t.ts <= i.ts).length;
  const hourLocal = (new Date(i.ts).getUTCHours() + 24 - 5) % 24; // Lima (UTC-5) como referencia del MVP
  const risk = riskScore({
    amountUsdMinor: usd, perTxLimitUsdMinor: prof.offlinePerTxLimitUsdMinor, dailyLimitUsdMinor: prof.offlineDailyLimitUsdMinor,
    dailyUsedUsdMinor: usedToday, txLastHour, merchantUnlisted: unlisted, foreign: !!country && country !== 'PE', hourLocal,
    channel: i.channel, untrustedDevice: !payer.trusted, activeRiskFlag: await activeRiskFlag(ctx, prof.userRef),
  });
  if (risk.score > ctx.cfg.riskStepUpThreshold) {
    const proof = i.stepUp?.smsProof;
    const expected = hmacHex(smsKey(ctx, payer.id, i.keyEpoch), i.txId).slice(0, 16);
    const ok = !!i.stepUp?.biometric && !!i.stepUp.pin && !!proof && safeEqualHex(proof, expected);
    if (!ok) return decline('step_up_required', { riskScore: risk.score, stepUpRequired: ['biometric', 'pin', 'sms_confirm'] });
  }

  // --- liquidación (todo bajo lock de pagador; wallet bajo su propio lock)
  return ctx.lock(`wallet:${payer.id}`, async () => {
    const wallet = (await ctx.store.get<Wallet>('wallets', payer.id)) ?? { deviceId: payer.id, balances: {} };
    const bal = wallet.balances[i.payerCurrency] ?? 0;
    if (bal < i.payerAmountMinor) return decline('insufficient_funds', { riskScore: risk.score });

    // Conciliación FX diferida: precio justo con la tasa vigente del servidor; ajuste acotado a ±(2 x margen).
    const latest = await ctx.store.get<{ id: string }>('rates_latest', 'latest');
    const cur = latest ? await ctx.store.get<Awaited<ReturnType<typeof getSnapshot>>>('rates', latest.id) : snap;
    const fairRate = i.currency === i.payerCurrency ? 1_000_000 : crossRateMicros(cur ?? snap, i.payerCurrency, i.currency);
    let adj = fairPriceMinor(i.amountMinor, fairRate) - i.payerAmountMinor;
    const cap = Math.floor((i.payerAmountMinor * snap.marginBps * 2) / 10_000);
    adj = Math.max(-cap, Math.min(cap, adj));
    if (adj > 0) adj = Math.min(adj, bal - i.payerAmountMinor);
    const finalPrice = i.payerAmountMinor + adj;
    const fx = { agreedRateMicros: i.rateMicros, fairRateMicros: fairRate, adjustmentMinor: adj, favors: adj < 0 ? 'user' as const : adj > 0 ? 'merchant' as const : 'none' as const };

    // Marcas atómicas anti doble gasto (insert devuelve false si otro proceso ganó la carrera).
    if (!(await ctx.store.insert('counters', `${payer.id}:${i.counter}`, { txId: i.txId })) && (await ctx.store.get<{ txId: string }>('counters', `${payer.id}:${i.counter}`))?.txId !== i.txId) {
      return decline('counter_reuse', { violation: await violate(ctx, payer, 'counter_reuse', i.txId, { counter: i.counter }) });
    }
    tok.status = 'used'; tok.usedBy = i.txId;
    await ctx.store.put('tokens', tok.token, tok);

    wallet.balances[i.payerCurrency] = bal - finalPrice;
    await ctx.store.put('wallets', payer.id, wallet);
    if (i.payeeDeviceId) {
      await ctx.lock(`wallet:${i.payeeDeviceId}`, async () => {
        const w = (await ctx.store.get<Wallet>('wallets', i.payeeDeviceId!)) ?? { deviceId: i.payeeDeviceId!, balances: {} };
        w.balances[i.currency] = (w.balances[i.currency] ?? 0) + i.amountMinor;
        await ctx.store.put('wallets', i.payeeDeviceId!, w);
      });
    }
    const rec: TxRecord = {
      txId: i.txId, payerDeviceId: payer.id, payeeDeviceId: i.payeeDeviceId, payeeRef: i.payeeRef, amountMinor: i.amountMinor, currency: i.currency,
      payerAmountMinor: i.payerAmountMinor, payerCurrency: i.payerCurrency, finalPayerAmountMinor: finalPrice, usdMinor: usd, channel: i.channel,
      ts: i.ts, settledAt: ctx.now(), day, riskScore: risk.score, intentHash: intentHash(i), via, fx, fxStatus: 'reconciled', status: 'settled',
    };
    await ctx.store.put('txs', i.txId, rec);
    if (i.payeeDeviceId) await ctx.store.put('txs_by_payee', `${i.payeeDeviceId}:${i.txId}`, { txId: i.txId, payeeDeviceId: i.payeeDeviceId });
    await ctx.appendLog(`dev:${payer.id}`, 'payment_settled', { txId: i.txId, amountMinor: i.amountMinor, currency: i.currency, via, risk: risk.score });
    await ctx.emit(payer.tenantId, 'payment.settled', { txId: i.txId, payerDeviceId: payer.id, payeeDeviceId: i.payeeDeviceId ?? null, amountMinor: i.amountMinor, currency: i.currency });
    return { txId: i.txId, status: 'settled' as const, riskScore: risk.score, fx };
  });
}

export async function authorizeOffline(ctx: Ctx, tenant: Tenant, v: Voucher): Promise<TxResult> {
  const payer = await ctx.store.get<Device>('devices', v.intent?.payerDeviceId ?? '');
  if (payer && payer.tenantId !== tenant.id && !tenant.admin) return { txId: v.intent.txId, status: 'rejected', reason: 'payer_unknown' };
  if (v.payeeAck && v.payeeAck.payeeDeviceId !== v.intent.payeeDeviceId) return { txId: v.intent.txId, status: 'rejected', reason: 'payee_ack_mismatch' };
  if (v.payeeAck) {
    const payee = await ctx.store.get<Device>('devices', v.payeeAck.payeeDeviceId);
    if (!payee || !ecdsaVerify(payee.publicKey, canonical({ txId: v.intent.txId, payeeDeviceId: payee.id }), v.payeeAck.sig)) return { txId: v.intent.txId, status: 'rejected', reason: 'payee_ack_invalid' };
  }
  return processVoucher(ctx, v, 'authorize');
}

export interface ReconcileResult {
  deviceId: string; accepted: number; lastSeq: number; lastHash: string; chainOk: boolean; chainError?: string; deviceStatus: string;
  results: { seq: number; txId?: string; status: TxStatus | 'ledger_ok' | 'chain_broken'; reason?: string }[];
}

export function entryHash(e: Pick<LedgerEntry, 'seq' | 'counter' | 'prevHash' | 'keyEpoch' | 'type' | 'payload'>): string {
  return sha256Hex(canonical({ seq: e.seq, counter: e.counter, prevHash: e.prevHash, keyEpoch: e.keyEpoch, type: e.type, payload: e.payload }));
}

/** Replay del ledger offline (WAL) de un dispositivo: verifica cadena hash+HMAC+firma, contador monotónico y liquida cada pago. */
export async function reconcile(ctx: Ctx, tenant: Tenant, deviceId: string, entries: LedgerEntry[]): Promise<ReconcileResult> {
  const d0 = await getDevice(ctx, deviceId, tenant);
  return ctx.lock(`ledger:${d0.id}`, async () => {
    const d = await getDevice(ctx, deviceId, tenant);
    const out: ReconcileResult = { deviceId: d.id, accepted: 0, lastSeq: d.lastEntrySeq, lastHash: d.lastEntryHash, chainOk: true, deviceStatus: d.status, results: [] };
    const sorted = [...entries].sort((a, b) => a.seq - b.seq);
    for (const e of sorted) {
      if (e.seq <= d.lastEntrySeq) {
        // ya visto: debe ser idéntico, si no es manipulación
        if (e.seq === d.lastEntrySeq && e.hash === d.lastEntryHash) { out.results.push({ seq: e.seq, status: 'duplicate' }); continue; }
        const known = await ctx.store.get<{ hash: string }>('ledger_seen', `${d.id}:${e.seq}`);
        if (known && known.hash === e.hash) { out.results.push({ seq: e.seq, status: 'duplicate' }); continue; }
        await breakChain(ctx, d, out, e, 'replay_mismatch');
        break;
      }
      const err = checkEntry(ctx, d, e);
      if (err) { await breakChain(ctx, d, out, e, err); break; }

      const p = e.payload as { voucher?: Voucher };
      if (e.type === 'PAY_OUT' || e.type === 'PAY_IN') {
        const v = p.voucher;
        if (!v?.intent) { await breakChain(ctx, d, out, e, 'payload_invalid'); break; }
        let r: TxResult;
        if (e.type === 'PAY_OUT' && (v.intent.payerDeviceId !== d.id || v.intent.counter !== e.counter)) {
          r = { txId: v.intent.txId, status: 'rejected', reason: 'entry_intent_mismatch' };
        } else if (e.type === 'PAY_IN' && (v.intent.payeeDeviceId !== d.id || !v.payeeAck || v.payeeAck.payeeDeviceId !== d.id || !ecdsaVerify(d.publicKey, canonical({ txId: v.intent.txId, payeeDeviceId: d.id }), v.payeeAck.sig))) {
          r = { txId: v.intent.txId, status: 'rejected', reason: 'payee_ack_invalid' };
        } else {
          r = await processVoucher(ctx, v, 'reconcile');
        }
        out.results.push({ seq: e.seq, txId: r.txId, status: r.status, reason: r.reason });
      } else {
        out.results.push({ seq: e.seq, status: 'ledger_ok' });
      }
      d.lastEntrySeq = e.seq; d.lastEntryHash = e.hash; d.lastCounter = e.counter;
      await ctx.store.put('ledger_seen', `${d.id}:${e.seq}`, { hash: e.hash });
      out.accepted++;
    }
    const fresh = await ctx.store.get<Device>('devices', d.id); // processVoucher pudo cambiar el estado
    if (fresh) { fresh.lastEntrySeq = d.lastEntrySeq; fresh.lastEntryHash = d.lastEntryHash; fresh.lastCounter = d.lastCounter; await saveDevice(ctx, fresh); out.deviceStatus = fresh.status; }
    out.lastSeq = d.lastEntrySeq; out.lastHash = d.lastEntryHash;
    await ctx.appendLog(`dev:${d.id}`, 'reconcile', { accepted: out.accepted, chainOk: out.chainOk, lastSeq: out.lastSeq });
    return out;
  });
}

function checkEntry(ctx: Ctx, d: Device, e: LedgerEntry): string | undefined {
  if (e.seq !== d.lastEntrySeq + 1) return 'ledger_gap';
  if (e.prevHash !== d.lastEntryHash) return 'prev_hash_mismatch';
  if (e.hash !== entryHash(e)) return 'hash_mismatch';
  if (e.keyEpoch < d.minKeyEpoch || e.keyEpoch > d.keyEpoch) return 'key_epoch_invalid';
  if (!safeEqualHex(e.mac, hmacHex(ledgerKey(ctx, d.id, e.keyEpoch), e.hash))) return 'mac_invalid';
  if (!ecdsaVerify(d.publicKey, e.hash, e.sig)) return 'signature_invalid';
  if (!Number.isSafeInteger(e.counter) || e.counter <= d.lastCounter) return 'counter_not_monotonic';
  return undefined;
}

async function breakChain(ctx: Ctx, d: Device, out: ReconcileResult, e: LedgerEntry, reason: string): Promise<void> {
  out.chainOk = false;
  out.chainError = reason;
  out.results.push({ seq: e.seq, status: 'chain_broken', reason });
  ctx.log.warn({ deviceId: d.id, seq: e.seq, reason }, 'ledger offline rechazado');
  const cur = await ctx.store.get<Device>('devices', d.id);
  if (cur && cur.status === 'active') {
    await setStatus(ctx, cur, 'locked', `ledger_${reason}`);
    const prof = await getProfile(ctx, d.id);
    if (prof.phone) await ctx.enqueue({ kind: 'sms', to: prof.phone, deviceId: d.id, tenantId: d.tenantId, body: 'SafeWallet: tu ledger offline fue rechazado y el dispositivo quedó bloqueado preventivamente.' });
  }
  await ctx.appendLog(`dev:${d.id}`, 'ledger_rejected', { seq: e.seq, reason });
  await ctx.emit(d.tenantId, 'fraud.ledger_tampered', { deviceId: d.id, seq: e.seq, reason });
}

export async function txHistory(ctx: Ctx, tenant: Tenant, deviceId: string): Promise<TxRecord[]> {
  await getDevice(ctx, deviceId, tenant);
  const out = await ctx.store.find<TxRecord>('txs', { payerDeviceId: deviceId });
  const inc = await ctx.store.find<{ txId: string }>('txs_by_payee', { payeeDeviceId: deviceId });
  for (const r of inc) { const t = await ctx.store.get<TxRecord>('txs', r.txId); if (t) out.push(t); }
  return out.sort((a, b) => a.ts - b.ts);
}

export { GENESIS_HASH };
