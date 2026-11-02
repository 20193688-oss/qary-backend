/** Genera vectores de prueba cruzados TypeScript↔Dart en mobile/test/vectors.json. */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '../util/canonical.js';
import { aesGcmEncrypt, ecdsaSign, generateKeyPair, hkdf, hmacHex, wrapFor, sha256Hex, randomHex } from '../util/crypto.js';
import { computeArqc } from '../services/tokenization.js';
import { entryHash } from '../services/payments.js';
import { buildEmv, parseEmv } from '../services/qr-interop.js';
import { crossRateMicros, fairPriceMinor, payerPriceMinor, REFERENCE_RATES_MICROS, toUsdMinor } from '../services/rates.js';
import { riskScore, type RiskInput } from '../services/risk.js';
import { encodeSmsPayment } from '../services/sms.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../mobile/test/vectors.json');
const jwkOf = (pem: string) => { const j = createPrivateKey(pem).export({ format: 'jwk' }); return { d: j.d!, x: j.x!, y: j.y! }; };

const dev = generateKeyPair();
const srv = generateKeyPair();
const wrapMsg = Buffer.from('{"k":"luk-material"}');
const info = 'sw-luk|vector';
const aesKey = hkdf(Buffer.from('00'.repeat(32), 'hex'), 'salt', 'aes-vector');
const sealed = aesGcmEncrypt(aesKey, Buffer.from('hola mundo'), 'aad-vector');

const snapBody = { id: 'rs_vector', base: 'USD', asOf: 1000, expiresAt: 999999999, ratesMicros: { ...REFERENCE_RATES_MICROS }, marginBps: 200, source: 'vector' };
const snapshot = { ...snapBody, sig: ecdsaSign(srv.privateKeyPem, canonical(snapBody)) };
const qrBody = { v: 1, qrId: 'qr1', payeeDeviceId: 'a'.repeat(32), amountMinor: 1200, currency: 'USD', rateSnapshotId: 'rs_vector', iat: 1, exp: 4102444800000 };
const qr = 'SWQR1:' + Buffer.from(JSON.stringify({ p: { ...qrBody, rates: snapshot }, s: ecdsaSign(srv.privateKeyPem, canonical(qrBody)) })).toString('base64url');

const luk = hkdf(Buffer.from('11'.repeat(32), 'hex'), 'dev', 'luk|tok|1');
const arqcIn = { token: '5000000000000009', amountMinor: 1234, currency: 'USD', counter: 7, txId: 'abcdef012345' };
const ledgerKey = hkdf(Buffer.from('22'.repeat(32), 'hex'), 'dev', 'ledger-mac|1');
const entryBase = { seq: 3, counter: 9, prevHash: '0'.repeat(64), keyEpoch: 1, type: 'PAY_OUT' as const, payload: { voucher: { intent: { txId: 'abcdef012345', amountMinor: 1234 }, payerSig: 'x' } } };
const eh = entryHash(entryBase);

const smsKey = Buffer.from('33'.repeat(32), 'hex');
const smsPayload = { t: 'ab'.repeat(6), to: '+51999111222', a: 1500, c: 'PEN' as const, pc: 'USD' as const, s: 'rs_vector', m: 200, k: '5'.repeat(16), q: 'f'.repeat(32), n: 3, ts: 1700000000000, e: 1 };
const smsMsg = encodeSmsPayment(smsKey, 'c'.repeat(32), 1, smsPayload);

const emvPayload = buildEmv({ dynamic: true, guid: 'pe.com.yape', account: '999888777', currencyNumeric: '604', amount: '12.50', country: 'PE', name: 'TAXI LIMA', city: 'LIMA', reference: 'R1' });
const emvInfo = parseEmv(emvPayload);

const base: RiskInput = { amountUsdMinor: 100, perTxLimitUsdMinor: 10000, dailyLimitUsdMinor: 20000, dailyUsedUsdMinor: 0, txLastHour: 0, merchantUnlisted: false, foreign: false, hourLocal: 12, channel: 'ble', untrustedDevice: false, activeRiskFlag: false };
const riskCases = [base, { ...base, amountUsdMinor: 10000, dailyUsedUsdMinor: 10000, txLastHour: 7, merchantUnlisted: true, foreign: true, hourLocal: 2 }, { ...base, channel: 'sms', activeRiskFlag: true, amountUsdMinor: 5000 }].map((i) => ({ input: i, score: riskScore(i).score }));

const doc = {
  canonical: [{ json: '{"b":1,"a":[true,null,"x\\n\\"é"],"c":{"z":2,"y":-3}}', expected: canonical({ b: 1, a: [true, null, 'x\n"é'], c: { z: 2, y: -3 } }) }],
  ecdsa: { publicKey: dev.publicKey, message: 'mensaje-de-prueba', sig: ecdsaSign(dev.privateKeyPem, 'mensaje-de-prueba') },
  ecies: { privateJwk: jwkOf(dev.privateKeyPem), publicKey: dev.publicKey, info, plaintext: wrapMsg.toString('base64url'), wrapped: wrapFor(dev.publicKey, wrapMsg, info) },
  hkdf: { ikm: '00'.repeat(32), salt: 'salt', info: 'aes-vector', out: aesKey.toString('hex') },
  aes: { key: aesKey.toString('hex'), aad: 'aad-vector', plaintext: 'hola mundo', sealed },
  hmac: { key: ledgerKey.toString('hex'), data: 'dato', out: hmacHex(ledgerKey, 'dato') },
  sha256: { data: 'abc', out: sha256Hex('abc') },
  arqc: { luk: luk.toString('hex'), input: arqcIn, out: computeArqc(luk, arqcIn) },
  entry: { base: entryBase, hash: eh, ledgerKey: ledgerKey.toString('hex'), mac: hmacHex(ledgerKey, eh) },
  sms: { key: smsKey.toString('hex'), deviceId: 'c'.repeat(32), epoch: 1, payload: smsPayload, message: smsMsg },
  emv: { payload: emvPayload, info: emvInfo },
  fx: {
    ratesMicros: REFERENCE_RATES_MICROS,
    cross: (['PEN', 'USD', 'EUR', 'CRC', 'VES', 'COP'] as const).flatMap((a) => (['PEN', 'USD', 'EUR', 'CRC', 'VES', 'COP'] as const).map((b) => ({ src: a, dst: b, micros: crossRateMicros({ ratesMicros: REFERENCE_RATES_MICROS }, a, b) }))),
    price: [[1000, 1_000_000, 0], [1000, 266_667, 200], [12345, 3_750_000, 200], [999_999_999, 1_066_666_667, 200]].map(([d, r, m]) => ({ dest: d, rate: r, margin: m, price: payerPriceMinor(d, r, m), fair: fairPriceMinor(d, r) })),
    usd: [['PEN', 375], ['COP', 4_000_000], ['EUR', 920]].map(([c, m]) => ({ currency: c, minor: m, usd: toUsdMinor({ ratesMicros: REFERENCE_RATES_MICROS }, c as 'PEN', m as number) })),
  },
  risk: riskCases,
  snapshot: { serverPublicKey: srv.publicKey, snapshot },
  qr: { serverPublicKey: srv.publicKey, qr, qrId: 'qr1' },
  randomSample: randomHex(4),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 1));
void createPublicKey;
console.log('vectores escritos en', out);
