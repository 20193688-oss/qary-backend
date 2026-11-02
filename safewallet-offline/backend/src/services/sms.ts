import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Ctx } from '../ctx.js';
import { aesGcmDecrypt, aesGcmEncrypt } from '../util/crypto.js';
import { canonical } from '../util/canonical.js';
import { badRequest } from '../util/errors.js';
import { CURRENCIES, type Currency, type Device, type Intent, type Tenant } from '../types.js';
import { smsKey } from './devices.js';
import { crossRateMicros, getSnapshot, payerPriceMinor } from './rates.js';
import { processVoucher, type TxResult } from './payments.js';
import { handleSosSms } from './panic.js';

export interface SmsPay { t: string; to: string; a: number; c: Currency; pc: Currency; s: string; m: number; k: string; q: string; n: number; ts: number; g?: string; e: number }
const PREFIX = 'SWPAY1';

/** Formato SMS: SWPAY1.<deviceId>.<epoch>.<base64url(iv|ct|tag)>, con ct = AES-256-GCM(deflateRaw(JSON canónico)). */
export function encodeSmsPayment(key: Buffer, deviceId: string, epoch: number, p: SmsPay): string {
  const z = deflateRawSync(Buffer.from(canonical(p)), { level: 9 });
  const s = aesGcmEncrypt(key, z, `sw-sms|${deviceId}|${epoch}`);
  const blob = Buffer.concat([Buffer.from(s.iv, 'base64url'), Buffer.from(s.ct, 'base64url'), Buffer.from(s.tag, 'base64url')]);
  return `${PREFIX}.${deviceId}.${epoch}.${blob.toString('base64url')}`;
}

export function decodeSmsPayment(key: Buffer, msg: string): SmsPay {
  const [, deviceId, epochS, b64] = msg.split('.');
  const blob = Buffer.from(b64, 'base64url');
  if (blob.length < 29) throw badRequest('sms_malformed', 'SMS de pago truncado');
  const plain = aesGcmDecrypt(key, { iv: blob.subarray(0, 12).toString('base64url'), ct: blob.subarray(12, blob.length - 16).toString('base64url'), tag: blob.subarray(blob.length - 16).toString('base64url') }, `sw-sms|${deviceId}|${Number(epochS)}`);
  return JSON.parse(inflateRawSync(plain, { maxOutputLength: 4096 }).toString('utf8')) as SmsPay;
}

export async function handleInboundSms(ctx: Ctx, tenant: Tenant, m: { from: string; to: string; body: string }): Promise<{ kind: 'sos' | 'payment' | 'ignored'; result?: unknown }> {
  const body = m.body.trim();
  if (/^SAFE-SOS-/i.test(body)) return { kind: 'sos', result: await handleSosSms(ctx, tenant, m) };
  if (!body.startsWith(PREFIX + '.')) return { kind: 'ignored' };
  const parts = body.split('.');
  if (parts.length !== 4 || !/^[0-9a-f]{32}$/.test(parts[1]) || !/^\d+$/.test(parts[2])) throw badRequest('sms_malformed', 'formato SWPAY1 inválido');
  const payer = await ctx.store.get<Device>('devices', parts[1]);
  if (!payer || payer.tenantId !== tenant.id) throw badRequest('sms_unknown_device', 'dispositivo desconocido');
  const epoch = Number(parts[2]);
  if (epoch < payer.minKeyEpoch || epoch > payer.keyEpoch) throw badRequest('sms_key_epoch', 'época de clave inválida');
  let p: SmsPay;
  try { p = decodeSmsPayment(smsKey(ctx, payer.id, epoch), body); } catch { throw badRequest('sms_auth_failed', 'SMS no autenticado (AES-GCM)'); }
  if (!CURRENCIES.includes(p.c) || !CURRENCIES.includes(p.pc)) throw badRequest('sms_bad_currency', 'moneda inválida');
  const payee = await ctx.store.get<{ deviceId: string }>('phones', p.to);
  if (!payee) throw badRequest('sms_unknown_payee', 'el número destino no está registrado en SafeWallet');
  const snap = await getSnapshot(ctx, p.s);
  const rate = p.c === p.pc ? 1_000_000 : crossRateMicros(snap, p.pc, p.c);
  const intent: Intent = {
    txId: p.t, payerDeviceId: payer.id, payeeDeviceId: payee.deviceId, amountMinor: p.a, currency: p.c,
    payerAmountMinor: payerPriceMinor(p.a, rate, p.m), payerCurrency: p.pc, rateMicros: rate, marginBps: p.m, rateSnapshotId: p.s,
    token: p.k, arqc: p.q, counter: p.n, channel: 'sms', ts: p.ts, nonce: p.t, keyEpoch: epoch, ...(p.g ? { geo: { country: p.g } } : {}),
  };
  const result: TxResult = await processVoucher(ctx, { intent, payerSig: 'sms-aead' }, 'sms', { preAuthenticated: true });
  return { kind: 'payment', result };
}
