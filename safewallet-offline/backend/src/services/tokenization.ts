import { randomInt } from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { hmacHex, randomHex, wrapFor } from '../util/crypto.js';
import { badRequest, notFound } from '../util/errors.js';
import type { Currency, Tenant } from '../types.js';
import { CURRENCIES } from '../types.js';
import { assertOperable, getDevice, lukFor } from './devices.js';

export function luhnValid(pan: string): boolean {
  if (!/^\d{12,19}$/.test(pan)) return false;
  let sum = 0;
  for (let i = 0; i < pan.length; i++) {
    let d = Number(pan[pan.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
function luhnCheckDigit(body: string): string {
  for (let c = 0; c < 10; c++) if (luhnValid(body + c)) return String(c);
  throw new Error('unreachable');
}
const brandOf = (pan: string): string => (pan.startsWith('4') ? 'visa' : /^5[1-5]/.test(pan) ? 'mastercard' : /^3[47]/.test(pan) ? 'amex' : 'other');

export interface Token { token: string; deviceId: string; cardRef: string; expiresAt: number; status: 'active' | 'used' | 'revoked'; lukEpoch: number; usedBy?: string; createdAt: number; [k: string]: unknown }

export const MAX_TOKEN_TTL_HOURS = 168;

export async function tokenize(ctx: Ctx, tenant: Tenant, req: { deviceId: string; pan: string; expMonth: number; expYear: number; currency: Currency; count?: number; ttlHours?: number }) {
  const d = await getDevice(ctx, req.deviceId, tenant);
  assertOperable(d);
  const pan = req.pan.replace(/[\s-]/g, '');
  if (!luhnValid(pan)) throw badRequest('invalid_pan', 'número de tarjeta inválido (Luhn)');
  if (!CURRENCIES.includes(req.currency)) throw badRequest('invalid_currency', 'moneda no soportada');
  const nowD = new Date(ctx.now());
  const expEnd = Date.UTC(req.expYear, req.expMonth, 1);
  if (req.expMonth < 1 || req.expMonth > 12 || expEnd <= nowD.getTime()) throw badRequest('card_expired', 'tarjeta vencida o vencimiento inválido');
  const count = req.count ?? 10;
  const ttlHours = Math.min(req.ttlHours ?? 72, MAX_TOKEN_TTL_HOURS);
  if (count < 1 || count > 50) throw badRequest('invalid_count', 'count debe estar entre 1 y 50');

  const cardRef = 'card_' + hmacHex(ctx.derive('pan', 'card-ref'), pan).slice(0, 24); // el PAN nunca se almacena
  await ctx.store.put('cards', cardRef, { cardRef, deviceId: d.id, last4: pan.slice(-4), brand: brandOf(pan), currency: req.currency, createdAt: ctx.now() });

  const tokens: Token[] = [];
  const lukMap: Record<string, string> = {};
  while (tokens.length < count) {
    const body = '5' + Array.from({ length: 14 }, () => String(randomInt(0, 10))).join('');
    const token = body + luhnCheckDigit(body);
    const t: Token = { token, deviceId: d.id, cardRef, expiresAt: ctx.now() + ttlHours * 3600_000, status: 'active', lukEpoch: d.keyEpoch, createdAt: ctx.now() };
    if (!(await ctx.store.insert('tokens', token, t))) continue; // colisión: reintenta
    tokens.push(t);
    lukMap[token] = lukFor(ctx, d.id, token, d.keyEpoch).toString('base64url');
  }
  await ctx.appendLog(`dev:${d.id}`, 'tokenize', { cardRef, count, ttlHours });
  return {
    cardRef, last4: pan.slice(-4), brand: brandOf(pan),
    tokens: tokens.map((t) => ({ token: t.token, expiresAt: t.expiresAt })),
    lukBundle: wrapFor(d.publicKey, Buffer.from(canonical(lukMap)), `sw-luk|${d.id}`),
  };
}

/** Criptograma ARQC offline: HMAC-SHA256(LUK, datos de la transacción), 16 bytes hex. Calculado en el Secure Element del dispositivo. */
export function arqcData(i: { token: string; amountMinor: number; currency: string; counter: number; txId: string }): string {
  return canonical({ token: i.token, amountMinor: i.amountMinor, currency: i.currency, counter: i.counter, txId: i.txId });
}
export const computeArqc = (luk: Buffer, i: Parameters<typeof arqcData>[0]): string => hmacHex(luk, arqcData(i)).slice(0, 32);

export async function revokeTokens(ctx: Ctx, deviceId: string, reason: string): Promise<number> {
  const all = await ctx.store.find<Token>('tokens', { deviceId });
  let n = 0;
  for (const t of all) {
    if (t.status === 'active') { t.status = 'revoked'; await ctx.store.put('tokens', t.token, t); n++; }
  }
  await ctx.appendLog(`dev:${deviceId}`, 'tokens_revoked', { count: n, reason });
  return n;
}

export async function revokeCardTokens(ctx: Ctx, tenant: Tenant, deviceId: string, cardRef: string): Promise<number> {
  await getDevice(ctx, deviceId, tenant);
  const card = await ctx.store.get<{ deviceId: string }>('cards', cardRef);
  if (!card || card.deviceId !== deviceId) throw notFound('card_not_found', 'tarjeta no encontrada');
  const all = await ctx.store.find<Token>('tokens', { deviceId, cardRef });
  let n = 0;
  for (const t of all) if (t.status === 'active') { t.status = 'revoked'; await ctx.store.put('tokens', t.token, t); n++; }
  await ctx.appendLog(`dev:${deviceId}`, 'tokens_revoked', { count: n, reason: 'card_revoked', cardRef });
  return n;
}

/** Aprovisionamiento a Google Wallet / Apple Wallet (simulado): entrega un paquete opaco firmado + tokens de TTL extendido. */
export async function provisionWallet(ctx: Ctx, tenant: Tenant, req: { deviceId: string; wallet: 'google_pay' | 'apple_pay'; cardRef: string }) {
  const d = await getDevice(ctx, req.deviceId, tenant);
  assertOperable(d);
  const card = await ctx.store.get<{ deviceId: string; last4: string; brand: string }>('cards', req.cardRef);
  if (!card || card.deviceId !== d.id) throw notFound('card_not_found', 'tarjeta no encontrada para este dispositivo');
  const tokens = (await ctx.store.find<Token>('tokens', { deviceId: d.id, cardRef: req.cardRef })).filter((t) => t.status === 'active' && t.expiresAt > ctx.now());
  if (!tokens.length) throw badRequest('no_active_tokens', 'no hay tokens activos: ejecuta /v1/tokenize primero');
  const ttlHours = req.wallet === 'google_pay' ? MAX_TOKEN_TTL_HOURS : 72;
  const tokenReferenceId = 'tr_' + randomHex(8);
  const payload = { wallet: req.wallet, tokenReferenceId, deviceId: d.id, cardRef: req.cardRef, last4: card.last4, brand: card.brand, issuedAt: ctx.now(), ttlHours };
  const limitations = req.wallet === 'google_pay'
    ? ['Google Pay exige refrescar tokens con red periódicamente; el MVP precarga tokens con TTL extendido (168 h).', 'La tokenización en Google Wallet real requiere ser emisor/TSP certificado; aquí se simula el aprovisionamiento.']
    : ['Apple Pay no permite pagos offline puros: el flujo offline usa el vault propio de SafeWallet con tokens precargados.', 'El aprovisionamiento real a Apple Wallet requiere entitlement de Apple y un emisor certificado.'];
  await ctx.appendLog(`dev:${d.id}`, 'wallet_provision', { wallet: req.wallet, tokenReferenceId });
  return { ...payload, limitations, signature: ctx.signServer(canonical(payload)) };
}
