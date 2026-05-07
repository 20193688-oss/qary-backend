import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSign(payload: string, secret = process.env.HMAC_SECRET ?? 'dev-hmac-secret'): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacVerify(payload: string, sig: string, secret = process.env.HMAC_SECRET ?? 'dev-hmac-secret'): boolean {
  const expected = hmacSign(payload, secret);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomDigits(n = 4): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}
