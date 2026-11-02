import { describe, expect, it } from 'vitest';
import { canonical } from '../util/canonical.js';
import { aesGcmDecrypt, aesGcmEncrypt, ecdsaSign, ecdsaVerify, generateKeyPair, hashPin, hkdf, unwrapWith, verifyPin, wrapFor } from '../util/crypto.js';
import { luhnValid } from '../services/tokenization.js';
import { buildEmv, crc16ccitt, parseEmv } from '../services/qr-interop.js';
import { crossRateMicros, fairPriceMinor, payerPriceMinor, REFERENCE_RATES_MICROS, toUsdMinor } from '../services/rates.js';
import { riskScore } from '../services/risk.js';
import { decodeSmsPayment, encodeSmsPayment } from '../services/sms.js';
import { MemoryKV, withLock } from '../db/kv.js';

describe('canonical JSON', () => {
  it('ordena claves y rechaza no enteros', () => {
    expect(canonical({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonical({ a: 1.5 })).toThrow();
  });
});

describe('criptografía real', () => {
  it('ECDSA P-256 firma/verifica y detecta manipulación', () => {
    const k = generateKeyPair();
    const sig = ecdsaSign(k.privateKeyPem, 'hola');
    expect(ecdsaVerify(k.publicKey, 'hola', sig)).toBe(true);
    expect(ecdsaVerify(k.publicKey, 'hol4', sig)).toBe(false);
    expect(ecdsaVerify(generateKeyPair().publicKey, 'hola', sig)).toBe(false);
    expect(ecdsaVerify(k.publicKey, 'hola', 'AAAA')).toBe(false);
  });
  it('AES-256-GCM detecta alteración de ciphertext, tag y AAD', () => {
    const key = hkdf(Buffer.alloc(32, 1), 'salt', 'info');
    const s = aesGcmEncrypt(key, Buffer.from('secreto'), 'aad');
    expect(aesGcmDecrypt(key, s, 'aad').toString()).toBe('secreto');
    expect(() => aesGcmDecrypt(key, s, 'otro')).toThrow();
    expect(() => aesGcmDecrypt(key, { ...s, ct: Buffer.from('xxxxxxx').toString('base64url') }, 'aad')).toThrow();
  });
  it('ECIES: solo el dueño de la clave abre el envoltorio', () => {
    const k = generateKeyPair();
    const w = wrapFor(k.publicKey, Buffer.from('luk'), 'ctx');
    expect(unwrapWith(k.privateKeyPem, w, 'ctx').toString()).toBe('luk');
    expect(() => unwrapWith(generateKeyPair().privateKeyPem, w, 'ctx')).toThrow();
    expect(() => unwrapWith(k.privateKeyPem, w, 'otro')).toThrow();
  });
  it('PIN con scrypt', () => {
    const h = hashPin('1234');
    expect(verifyPin('1234', h)).toBe(true);
    expect(verifyPin('1235', h)).toBe(false);
  });
});

describe('Luhn, EMVCo y FX', () => {
  it('Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });
  it('CRC16-CCITT vector estándar', () => { expect(crc16ccitt('123456789')).toBe('29B1'); });
  it('parsea EMVCo y detecta manipulación', () => {
    const q = buildEmv({ dynamic: false, guid: 'pe.com.yape', account: '999888777', currencyNumeric: '604', amount: '12.50', country: 'PE', name: 'TAXI LIMA', city: 'LIMA' });
    const i = parseEmv(q);
    expect(i).toMatchObject({ valid: true, wallet: 'yape', currency: 'PEN', amountMinor: 1250, merchantName: 'TAXI LIMA', dynamic: false });
    expect(() => parseEmv(q.replace('12.50', '99.50'))).toThrow(/CRC/);
    expect(() => parseEmv('00020101')).toThrow();
    expect(() => parseEmv('hola mundo no es un qr')).toThrow();
  });
  it('conversión determinista con margen', () => {
    const snap = { ratesMicros: REFERENCE_RATES_MICROS };
    expect(crossRateMicros(snap, 'PEN', 'USD')).toBe(266_667);
    expect(crossRateMicros(snap, 'USD', 'PEN')).toBe(3_750_000);
    expect(payerPriceMinor(1000, 1_000_000, 200)).toBe(1020);
    expect(fairPriceMinor(1000, 3_750_000)).toBe(267);
    expect(toUsdMinor(snap, 'PEN', 375)).toBe(100);
  });
});

describe('score de riesgo', () => {
  const base = { amountUsdMinor: 100, perTxLimitUsdMinor: 10000, dailyLimitUsdMinor: 20000, dailyUsedUsdMinor: 0, txLastHour: 0, merchantUnlisted: false, foreign: false, hourLocal: 12, channel: 'ble', untrustedDevice: false, activeRiskFlag: false };
  it('bajo para pago normal y >70 para pago extremo', () => {
    expect(riskScore(base).score).toBeLessThan(10);
    const hi = riskScore({ ...base, amountUsdMinor: 10000, dailyUsedUsdMinor: 10000, txLastHour: 7, merchantUnlisted: true, foreign: true, hourLocal: 2 });
    expect(hi.score).toBeGreaterThan(70);
    expect(riskScore({ ...base, untrustedDevice: true, activeRiskFlag: true, amountUsdMinor: 10000, txLastHour: 9, foreign: true }).score).toBeLessThanOrEqual(100);
  });
});

describe('SMS cifrado comprimido', () => {
  it('ida y vuelta y rechazo con clave errónea', () => {
    const key = Buffer.alloc(32, 7);
    const p = { t: 'ab'.repeat(6), to: '+51999111222', a: 1500, c: 'PEN' as const, pc: 'PEN' as const, s: 'rs_1', m: 200, k: '5'.repeat(16), q: 'f'.repeat(32), n: 3, ts: 1, e: 1 };
    const msg = encodeSmsPayment(key, 'a'.repeat(32), 1, p);
    expect(msg.startsWith('SWPAY1.')).toBe(true);
    expect(msg.length).toBeLessThan(480); // 3 SMS concatenados como máximo
    expect(decodeSmsPayment(key, msg)).toEqual(p);
    expect(() => decodeSmsPayment(Buffer.alloc(32, 8), msg)).toThrow();
  });
});

describe('KV y locks', () => {
  it('incr con TTL, setnx, take y exclusión mutua', async () => {
    let t = 0; const kv = new MemoryKV(() => t);
    expect(await kv.incr('a', 10)).toBe(1); expect(await kv.incr('a', 10)).toBe(2);
    t = 11_000; expect(await kv.incr('a', 10)).toBe(1);
    expect(await kv.setnx('x', '1', 5)).toBe(true); expect(await kv.setnx('x', '2', 5)).toBe(false);
    expect(await kv.take('x')).toBe('1'); expect(await kv.take('x')).toBeUndefined();
    let n = 0; let max = 0;
    await Promise.all(Array.from({ length: 5 }, () => withLock(kv, 'k', async () => { n++; max = Math.max(max, n); await new Promise((r) => setTimeout(r, 5)); n--; })));
    expect(max).toBe(1);
  });
});
