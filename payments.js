/**
 * QARY — Dynamic QR signer & verifier
 * ─────────────────────────────────────
 * HMAC-SHA256-signed payload for in-app QR payments.
 *
 * Usage:
 *   const { signQR, verifyQR } = require('./backend-qr-signer');
 *   const { qr_payload, tx_id } = signQR({ amount: 2850, currency: 'PEN' });
 *   const { valid, payload } = verifyQR(qr_payload);
 *
 * Environment:
 *   QR_SIGNING_SECRET  — 256-bit hex or base64 secret, rotated monthly
 *
 * Security notes:
 *   - Signature compared with crypto.timingSafeEqual to prevent timing attacks
 *   - Nonce tracking (Redis) prevents replay; see redeemQR() below
 *   - Short exp (default 15 min) limits the window for scan-and-pay
 */

'use strict';

const crypto = require('crypto');

const VERSION = 'v1';
const DEFAULT_EXPIRES_IN = 15 * 60; // 15 minutes

function getSecret() {
  const s = process.env.QR_SIGNING_SECRET;
  if (!s || s.length < 32) {
    throw new Error('QR_SIGNING_SECRET missing or too short (need ≥32 chars)');
  }
  return Buffer.from(s, 'utf8');
}

function b64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

/**
 * Canonical JSON: sort keys so signature is deterministic.
 * Must be used on both sign and verify sides.
 */
function canonicalJson(obj) {
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}

/**
 * Sign a payment payload and return the QR-ready string.
 * @param {{amount:number, currency:string, merchant?:string, metadata?:object, expires_in?:number}} opts
 * @returns {{qr_payload:string, tx_id:string, expires_at:string}}
 */
function signQR(opts) {
  if (!opts || typeof opts.amount !== 'number' || opts.amount <= 0) {
    throw new Error('amount is required and must be > 0');
  }
  const tx_id = 'tx_' + crypto.randomBytes(12).toString('hex');
  const nonce = crypto.randomBytes(8).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expires_in || DEFAULT_EXPIRES_IN);

  const payload = {
    v: 1,
    tx: tx_id,
    amt: Math.round(opts.amount), // always integer (minor units e.g. cents)
    cur: (opts.currency || 'PEN').toUpperCase(),
    mch: opts.merchant || 'qary.pe',
    iat: now,
    exp: exp,
    n: nonce,
    meta: opts.metadata || undefined
  };

  const json = canonicalJson(payload);
  const sig = crypto.createHmac('sha256', getSecret()).update(json).digest();

  const qr_payload = VERSION + '.' + b64url(Buffer.from(json, 'utf8')) + '.' + b64url(sig);

  return {
    qr_payload,
    tx_id,
    expires_at: new Date(exp * 1000).toISOString()
  };
}

/**
 * Verify a QR payload string.
 * @param {string} qr_payload
 * @returns {{valid:boolean, reason?:string, payload?:object}}
 */
function verifyQR(qr_payload) {
  if (typeof qr_payload !== 'string') {
    return { valid: false, reason: 'not_a_string' };
  }
  const parts = qr_payload.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'bad_format' };
  }
  const [version, p64, s64] = parts;
  if (version !== VERSION) {
    return { valid: false, reason: 'unsupported_version' };
  }

  let payload;
  try {
    const jsonBuf = b64urlDecode(p64);
    payload = JSON.parse(jsonBuf.toString('utf8'));
  } catch (e) {
    return { valid: false, reason: 'bad_payload' };
  }

  // Recompute signature using canonical form (re-serialize → same bytes)
  const canonical = canonicalJson(payload);
  const expected = crypto.createHmac('sha256', getSecret()).update(canonical).digest();
  const actual = b64urlDecode(s64);

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { valid: false, reason: 'bad_signature' };
  }

  // Expiration check
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    return { valid: false, reason: 'expired', payload };
  }

  return { valid: true, payload };
}

/**
 * Redeem a QR — call AFTER verifyQR() succeeds. Ensures the nonce hasn't
 * been used before (replay protection).
 *
 * @param {object} payload  — the verified payload from verifyQR
 * @param {object} redis    — a Redis client with async get/set/expire
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function redeemQR(payload, redis) {
  const key = 'qr:nonce:' + payload.n;
  const ttl = Math.max(60, (payload.exp || 0) - Math.floor(Date.now() / 1000));

  // SETNX returns 1 if set (unused), 0 if already exists (replay)
  const setResult = await redis.set(key, payload.tx, 'EX', ttl, 'NX');
  if (setResult === null) {
    return { ok: false, reason: 'replay_detected' };
  }
  return { ok: true };
}

module.exports = { signQR, verifyQR, redeemQR, canonicalJson };

// ──────────────────────────────────────────────────────────
// Quick self-test — run with: node backend-qr-signer.js
// ──────────────────────────────────────────────────────────
if (require.main === module) {
  process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'dev-secret-please-replace-with-64char-hex-in-production';

  const { qr_payload, tx_id, expires_at } = signQR({
    amount: 2850,
    currency: 'PEN',
    merchant: 'qary.pe',
    metadata: { ride_id: 'ride_77' },
    expires_in: 900
  });

  console.log('Signed QR:');
  console.log('  tx_id:', tx_id);
  console.log('  expires_at:', expires_at);
  console.log('  payload:', qr_payload);
  console.log('  length:', qr_payload.length, 'chars');

  console.log('\nVerify:');
  const v1 = verifyQR(qr_payload);
  console.log('  valid:', v1.valid);

  console.log('\nTamper test (flip one char of signature):');
  const tampered = qr_payload.slice(0, -1) + (qr_payload.slice(-1) === 'A' ? 'B' : 'A');
  const v2 = verifyQR(tampered);
  console.log('  valid:', v2.valid, '| reason:', v2.reason);
}
