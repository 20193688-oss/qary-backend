import type { Ctx } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { ecdsaVerify, randomHex, sha256Hex } from '../util/crypto.js';
import { badRequest, notFound } from '../util/errors.js';
import { CURRENCIES, type Currency, type Tenant, type Voucher } from '../types.js';
import { assertOperable, getDevice } from './devices.js';
import { ensureRates, verifySnapshot, type RateSnapshot } from './rates.js';
import { processVoucher, type TxResult, type Wallet } from './payments.js';
import type { Token } from './tokenization.js';

/* ---------------- EMVCo Merchant-Presented QR ---------------- */
export const NUMERIC_CURRENCY: Record<string, Currency> = { '604': 'PEN', '840': 'USD', '978': 'EUR', '188': 'CRC', '928': 'VES', '170': 'COP' };

export function crc16ccitt(s: string): string {
  let crc = 0xffff;
  for (const b of Buffer.from(s, 'utf8')) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function parseTlv(s: string): { tag: string; value: string }[] {
  const out: { tag: string; value: string }[] = [];
  let i = 0;
  while (i < s.length) {
    if (i + 4 > s.length) throw badRequest('emv_malformed', 'TLV truncado');
    const tag = s.slice(i, i + 2); const lenS = s.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenS)) throw badRequest('emv_malformed', 'tag o longitud no numérica');
    const len = Number(lenS);
    if (i + 4 + len > s.length) throw badRequest('emv_malformed', `longitud excede el payload en tag ${tag}`);
    out.push({ tag, value: s.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

export function tlv(tag: string, value: string): string { return tag + String(value.length).padStart(2, '0') + value; }

export function buildEmv(f: { dynamic: boolean; guid: string; account: string; mcc?: string; currencyNumeric: string; amount?: string; country: string; name: string; city: string; reference?: string }): string {
  let s = tlv('00', '01') + tlv('01', f.dynamic ? '12' : '11') + tlv('26', tlv('00', f.guid) + tlv('01', f.account));
  s += tlv('52', f.mcc ?? '0000') + tlv('53', f.currencyNumeric);
  if (f.amount) s += tlv('54', f.amount);
  s += tlv('58', f.country) + tlv('59', f.name) + tlv('60', f.city);
  if (f.reference) s += tlv('62', tlv('05', f.reference));
  s += '6304';
  return s + crc16ccitt(s);
}

export interface EmvInfo {
  valid: boolean; crcOk: boolean; dynamic: boolean; wallet: string; merchantName: string; city: string; country: string; mcc: string;
  currency: Currency | null; amountMinor: number | null; accountId: string; guid: string; reference?: string; emvHash: string;
}

export function walletOf(guid: string, name: string): string {
  const s = `${guid} ${name}`.toLowerCase();
  if (s.includes('yape')) return 'yape';
  if (s.includes('plin')) return 'plin';
  if (s.includes('interbank') || s.includes('ibk')) return 'interbank';
  if (s.includes('bcp')) return 'bcp';
  return 'unknown';
}

export function parseEmv(payload: string): EmvInfo {
  const p = payload.trim();
  const top = parseTlv(p);
  const get = (t: string) => top.find((x) => x.tag === t)?.value;
  if (get('00') !== '01') throw badRequest('emv_not_payment', 'no es un QR EMVCo de pago (tag 00 != 01)');
  const m = /6304([0-9A-Fa-f]{4})$/.exec(p);
  if (!m) throw badRequest('emv_no_crc', 'falta CRC (tag 63)');
  const crcOk = crc16ccitt(p.slice(0, p.length - 4)).toUpperCase() === m[1].toUpperCase();
  if (!crcOk) throw badRequest('emv_crc_invalid', 'CRC16 inválido: QR corrupto o manipulado');
  const acct = top.find((x) => { const n = Number(x.tag); return n >= 26 && n <= 51; });
  if (!acct) throw badRequest('emv_no_account', 'sin información de cuenta del comercio (tags 26-51)');
  const sub = parseTlv(acct.value);
  const guid = sub.find((x) => x.tag === '00')?.value ?? '';
  const accountId = sub.find((x) => x.tag === '01')?.value ?? '';
  const num = get('53') ?? '';
  const currency = NUMERIC_CURRENCY[num] ?? null;
  const amt = get('54');
  let amountMinor: number | null = null;
  if (amt !== undefined) {
    if (!/^\d+(\.\d{1,2})?$/.test(amt)) throw badRequest('emv_bad_amount', 'monto (tag 54) inválido');
    const [a, b = ''] = amt.split('.');
    amountMinor = Number(a) * 100 + Number(b.padEnd(2, '0'));
  }
  const add = get('62');
  const reference = add ? parseTlv(add).find((x) => x.tag === '05')?.value : undefined;
  const name = get('59') ?? '';
  return {
    valid: true, crcOk, dynamic: get('01') === '12', wallet: walletOf(guid, name), merchantName: name, city: get('60') ?? '', country: get('58') ?? '',
    mcc: get('52') ?? '', currency, amountMinor, accountId, guid, reference, emvHash: sha256Hex(p),
  };
}

/* ---------------- Pasarela simulada (Yape/Plin/otra) ---------------- */
export interface GatewayResult { status: 'ACCEPTED' | 'REJECTED'; gatewayRef: string; reason?: string }
/** Mock determinista del flujo de pasarela. Rechaza comercios cuyo nombre contenga REJECT. En producción se reemplaza por Niubiz/Izipay/API de la billetera. */
export function mockGatewayPay(wallet: string, p: { merchant: string; accountId: string; amountMinor: number; currency: string; reference: string }): GatewayResult {
  const gatewayRef = `${wallet.toUpperCase()}-${sha256Hex(p.reference).slice(0, 10)}`;
  if (p.merchant.toUpperCase().includes('REJECT')) return { status: 'REJECTED', gatewayRef, reason: 'merchant_rejected' };
  return { status: 'ACCEPTED', gatewayRef };
}

export async function routeEmvVoucher(ctx: Ctx, tenant: Tenant, req: { emvPayload: string; voucher: Voucher }) {
  const emv = parseEmv(req.emvPayload);
  const i = req.voucher.intent;
  if (i.channel !== 'qr_emv') throw badRequest('wrong_channel', "el voucher debe usar channel 'qr_emv'");
  if (i['emvHash'] !== emv.emvHash) throw badRequest('emv_hash_mismatch', 'el voucher no corresponde a este QR EMVCo');
  if (!emv.currency || emv.currency !== i.currency) throw badRequest('emv_currency_mismatch', 'moneda del QR distinta a la del voucher');
  if (emv.amountMinor !== null && emv.amountMinor !== i.amountMinor) throw badRequest('emv_amount_mismatch', 'monto del QR distinto al del voucher');
  const payer = await getDevice(ctx, i.payerDeviceId, tenant);
  assertOperable(payer);
  if (i.payeeRef !== `emv:${emv.wallet}:${emv.accountId}`) throw badRequest('payee_mismatch', 'payeeRef no coincide con la cuenta del QR');
  const r: TxResult = await processVoucher(ctx, req.voucher, 'emv');
  if (r.status === 'duplicate') {
    const route = await ctx.store.get<Record<string, unknown>>('emv_routes', i.txId);
    return { tx: r, gateway: route ?? null };
  }
  if (r.status !== 'settled') return { tx: r, gateway: null };
  const gw = mockGatewayPay(emv.wallet, { merchant: emv.merchantName, accountId: emv.accountId, amountMinor: i.amountMinor, currency: i.currency, reference: i.txId });
  const route = { txId: i.txId, wallet: emv.wallet, ...gw, routedAt: ctx.now(), refunded: false };
  if (gw.status === 'REJECTED') {
    await ctx.lock(`wallet:${payer.id}`, async () => {
      const w = (await ctx.store.get<Wallet>('wallets', payer.id))!;
      const tx = (await ctx.store.get<{ finalPayerAmountMinor: number; payerCurrency: string; status: string }>('txs', i.txId))!;
      w.balances[tx.payerCurrency] = (w.balances[tx.payerCurrency] ?? 0) + tx.finalPayerAmountMinor;
      await ctx.store.put('wallets', payer.id, w);
      await ctx.store.put('txs', i.txId, { ...(await ctx.store.get('txs', i.txId))!, status: 'refunded' });
    });
    route.refunded = true;
    await ctx.appendLog(`dev:${payer.id}`, 'payment_refunded', { txId: i.txId, reason: gw.reason });
  }
  await ctx.store.put('emv_routes', i.txId, route);
  return { tx: gw.status === 'REJECTED' ? { ...r, status: 'declined' as const, reason: gw.reason } : r, gateway: route };
}

/* ---------------- QR dinámico firmado por el backend ---------------- */
export interface DynamicQr { v: 1; qrId: string; payeeDeviceId: string; payeeDpan?: string; amountMinor: number; currency: Currency; rateSnapshotId: string; exp: number; iat: number; rates?: RateSnapshot }

export async function createDynamicQr(ctx: Ctx, tenant: Tenant, req: { deviceId: string; amountMinor: number; currency: Currency; ttlSeconds?: number; includeRates?: boolean }) {
  const d = await getDevice(ctx, req.deviceId, tenant);
  assertOperable(d);
  if (!CURRENCIES.includes(req.currency)) throw badRequest('invalid_currency', 'moneda no soportada');
  if (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0) throw badRequest('invalid_amount', 'monto inválido');
  const ttl = Math.min(req.ttlSeconds ?? 300, 3600);
  const snap = await ensureRates(ctx);
  const dpan = (await ctx.store.find<Token>('tokens', { deviceId: d.id })).find((t) => t.status === 'active' && t.expiresAt > ctx.now())?.token;
  const payload: DynamicQr = {
    v: 1, qrId: randomHex(8), payeeDeviceId: d.id, ...(dpan ? { payeeDpan: dpan } : {}), amountMinor: req.amountMinor, currency: req.currency,
    rateSnapshotId: snap.id, iat: ctx.now(), exp: ctx.now() + ttl * 1000, ...(req.includeRates === false ? {} : { rates: snap }),
  };
  const { rates: _r, ...signedPart } = payload; // la firma cubre todo salvo el snapshot completo (que ya está firmado y se identifica por id)
  const sig = ctx.signServer(canonical(signedPart));
  await ctx.store.put('qrs', payload.qrId, { qrId: payload.qrId, payeeDeviceId: d.id, amountMinor: req.amountMinor, currency: req.currency, exp: payload.exp });
  return { qrId: payload.qrId, expiresAt: payload.exp, qr: 'SWQR1:' + Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url') };
}

export function verifyDynamicQr(ctx: Ctx, qr: string): { valid: boolean; reason?: string; payload?: DynamicQr } {
  if (!qr.startsWith('SWQR1:')) return { valid: false, reason: 'bad_prefix' };
  let obj: { p: DynamicQr; s: string };
  try { obj = JSON.parse(Buffer.from(qr.slice(6), 'base64url').toString('utf8')); } catch { return { valid: false, reason: 'malformed' }; }
  const { rates, ...signedPart } = obj.p;
  if (!ecdsaVerify(ctx.secrets.server.publicKey, canonical(signedPart), obj.s)) return { valid: false, reason: 'bad_signature' };
  if (rates && (rates.id !== obj.p.rateSnapshotId || !verifySnapshot(rates, ctx.secrets.server.publicKey))) return { valid: false, reason: 'bad_rates_signature' };
  if (obj.p.exp < ctx.now()) return { valid: false, reason: 'expired', payload: obj.p };
  return { valid: true, payload: obj.p };
}

/** Vincula un voucher de canal 'qr' con su QR: monto, moneda, beneficiario y un solo uso. */
export async function consumeQr(ctx: Ctx, i: { nonce: string; txId: string; amountMinor: number; currency: string; payeeDeviceId?: string; ts: number }): Promise<string | undefined> {
  const qr = await ctx.store.get<{ amountMinor: number; currency: string; payeeDeviceId: string; exp: number }>('qrs', i.nonce);
  if (!qr) return 'qr_unknown';
  if (qr.amountMinor !== i.amountMinor || qr.currency !== i.currency || qr.payeeDeviceId !== i.payeeDeviceId) return 'qr_mismatch';
  if (i.ts > qr.exp + 5 * 60_000) return 'qr_expired';
  const first = await ctx.store.insert('qr_used', i.nonce, { txId: i.txId });
  if (!first && (await ctx.store.get<{ txId: string }>('qr_used', i.nonce))?.txId !== i.txId) return 'qr_already_used';
  return undefined;
}

export async function getQrStatus(ctx: Ctx, qrId: string) {
  const qr = await ctx.store.get<{ qrId: string; exp: number }>('qrs', qrId);
  if (!qr) throw notFound('qr_not_found', 'QR no encontrado');
  const used = await ctx.store.get<{ txId: string }>('qr_used', qrId);
  return { qrId, expired: qr.exp < ctx.now(), paid: !!used, txId: used?.txId ?? null };
}
