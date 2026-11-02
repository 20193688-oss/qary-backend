import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify,
  type KeyObject,
} from 'node:crypto';
import { badRequest } from './errors.js';

export const sha256Hex = (d: string | Buffer): string => createHash('sha256').update(d).digest('hex');
export const hmacHex = (key: Buffer, d: string | Buffer): string => createHmac('sha256', key).update(d).digest('hex');
export const randomHex = (n: number): string => randomBytes(n).toString('hex');
export const GENESIS_HASH = '0'.repeat(64);

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hkdf(ikm: Buffer, salt: string | Buffer, info: string, len = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, len));
}

/** Clave pública P-256 como punto sin comprimir (0x04||X||Y) en base64url. */
export interface KeyPair { publicKey: string; privateKeyPem: string }

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: raw.toString('base64url'), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

export function pubToKey(raw: string): KeyObject {
  let b: Buffer;
  try { b = Buffer.from(raw, 'base64url'); } catch { throw badRequest('bad_public_key', 'clave pública ilegible'); }
  if (b.length !== 65 || b[0] !== 4) throw badRequest('bad_public_key', 'la clave pública debe ser un punto P-256 sin comprimir (65 bytes)');
  try {
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' });
  } catch {
    throw badRequest('bad_public_key', 'el punto no pertenece a la curva P-256');
  }
}

/** Firma ECDSA P-256/SHA-256, formato IEEE P1363 (r||s, 64 bytes), base64url. */
export function ecdsaSign(privateKeyPem: string, data: string | Buffer): string {
  return sign('sha256', Buffer.from(data), { key: createPrivateKey(privateKeyPem), dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

export function ecdsaVerify(publicKeyRaw: string, data: string | Buffer, sigB64: string): boolean {
  try {
    const sig = Buffer.from(sigB64, 'base64url');
    if (sig.length !== 64) return false;
    return verify('sha256', Buffer.from(data), { key: pubToKey(publicKeyRaw), dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

export interface Sealed { iv: string; ct: string; tag: string }

export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad?: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: c.getAuthTag().toString('base64url') };
}

export function aesGcmDecrypt(key: Buffer, s: Sealed, aad?: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64url'));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(s.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64url')), d.final()]);
}

export interface Wrapped extends Sealed { epk: string }

/** ECIES: clave efímera P-256 + ECDH + HKDF + AES-256-GCM. Solo el dueño de la clave privada del dispositivo puede abrirlo. */
export function wrapFor(devicePublicKeyRaw: string, plaintext: Buffer, info: string): Wrapped {
  const eph = generateKeyPair();
  const shared = diffieHellman({ privateKey: createPrivateKey(eph.privateKeyPem), publicKey: pubToKey(devicePublicKeyRaw) });
  const key = hkdf(shared, '', info);
  return { epk: eph.publicKey, ...aesGcmEncrypt(key, plaintext, info) };
}

export function unwrapWith(privateKeyPem: string, w: Wrapped, info: string): Buffer {
  const shared = diffieHellman({ privateKey: createPrivateKey(privateKeyPem), publicKey: pubToKey(w.epk) });
  return aesGcmDecrypt(hkdf(shared, '', info), w, info);
}

/** Verificador de PIN con scrypt (parámetros embebidos en el hash). */
import { scryptSync } from 'node:crypto';
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export function verifyPin(pin: string, stored: string): boolean {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const calc = scryptSync(pin, Buffer.from(s, 'base64url'), 32, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(h, 'base64url');
  return calc.length === exp.length && timingSafeEqual(calc, exp);
}
