// Helper de los ejemplos cURL: actúa como "el dispositivo" (claves en un archivo temporal, solo sandbox).
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const canonical = (v) => v === null ? 'null' : typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}') : JSON.stringify(v);
const sig = (pem, data) => sign('sha256', Buffer.from(data), { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' }).toString('base64url');
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));
const [cmd, ...a] = process.argv.slice(2);

if (cmd === 'new') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
  const f = join(tmpdir(), `sw-dev-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(f, JSON.stringify({ publicKey: pub, pem: privateKey.export({ format: 'pem', type: 'pkcs8' }), counter: 0, seq: -1, prev: '0'.repeat(64) }), { mode: 0o600 });
  console.log(f);
} else if (cmd === 'attest') {
  const d = load(a[0]);
  const st = { nonce: a[1], publicKey: d.publicKey, platform: 'sandbox', buildId: 'sandbox-build-1', appHash: 'sandbox-app-hash', rooted: false, emulator: false, hooked: false, debuggable: false, integrityToken: 'MOCK-OK-curl', ts: Date.now() };
  console.log(JSON.stringify({ statement: st, signature: sig(d.pem, canonical(st)) }));
} else if (cmd === 'op') {
  const d = load(a[0]); const ts = Date.now();
  console.log(JSON.stringify({ ts, signature: sig(d.pem, canonical({ op: a[1], deviceId: a[2], ts })) }));
} else if (cmd === 'forensic') {
  const d = load(a[0]); const deviceId = a[1];
  const e = { index: 0, type: 'incident', ts: Date.now(), ciphertext: Buffer.from(a[2]).toString('base64url'), prevHash: '0'.repeat(64) };
  const hash = createHash('sha256').update(canonical({ deviceId, ...e })).digest('hex');
  console.log(JSON.stringify({ entries: [{ ...e, hash, sig: sig(d.pem, hash) }] }));
} else if (cmd === 'emv') {
  const crc = (s) => { let c = 0xffff; for (const b of Buffer.from(s)) { c ^= b << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); };
  const t = (tag, v) => tag + String(v.length).padStart(2, '0') + v;
  const s = t('00', '01') + t('01', '12') + t('26', t('00', 'pe.com.yape') + t('01', '999888777')) + t('52', '0000') + t('53', '604') + t('54', '12.50') + t('58', 'PE') + t('59', 'TAXI LIMA') + t('60', 'LIMA') + '6304';
  console.log(s + crc(s));
} else if (cmd === 'pay') {
  // Demuestra un pago real: tokeniza, firma un voucher a sí mismo-otro dispositivo, autoriza y reconcilia.
  const [file, base, key, id] = a; const d = load(file);
  const H = { 'x-api-key': key, 'content-type': 'application/json' };
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
  const get = async (p) => (await fetch(base + p, { headers: H })).json();
  const { generateKeyPairSync: g, diffieHellman, createPublicKey, createDecipheriv, hkdfSync } = await import('node:crypto');
  // 1) segundo dispositivo (beneficiario)
  const peer = g('ec', { namedCurve: 'prime256v1' }); const pj = peer.publicKey.export({ format: 'jwk' });
  const peerPub = Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, 'base64url'), Buffer.from(pj.y, 'base64url')]).toString('base64url');
  const pemP = peer.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const ch = await get('/v1/attest/challenge');
  const st = { nonce: ch.challenge, publicKey: peerPub, platform: 'sandbox', buildId: 'sandbox-build-1', appHash: 'sandbox-app-hash', rooted: false, emulator: false, hooked: false, debuggable: false, integrityToken: 'MOCK-OK-curl', ts: Date.now() };
  const att = await post('/v1/attest', { statement: st, signature: sig(pemP, canonical(st)) });
  // 2) claves del pagador (desenvuelve ECIES con su clave privada)
  const unwrap = (pem, w, info) => { const shared = diffieHellman({ privateKey: createPrivateKey(pem), publicKey: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(w.epk, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(w.epk, 'base64url').subarray(33).toString('base64url') }, format: 'jwk' }) }); const k = Buffer.from(hkdfSync('sha256', shared, '', info, 32)); const dec = createDecipheriv('aes-256-gcm', k, Buffer.from(w.iv, 'base64url')); dec.setAAD(Buffer.from(info)); dec.setAuthTag(Buffer.from(w.tag, 'base64url')); return Buffer.concat([dec.update(Buffer.from(w.ct, 'base64url')), dec.final()]); };
  const tok = await post('/v1/tokenize', { deviceId: id, pan: '4111111111111111', expMonth: 12, expYear: 2030, currency: 'PEN', count: 1 });
  const lukMap = JSON.parse(unwrap(d.pem, tok.lukBundle, `sw-luk|${id}`).toString());
  const token = tok.tokens[0].token; const luk = Buffer.from(lukMap[token], 'base64url');
  const rates = await get('/v1/rates');
  const txId = randomBytes(12).toString('hex'); const counter = 1; const amountMinor = 1500;
  const arqc = createHmac('sha256', luk).update(canonical({ token, amountMinor, currency: 'PEN', counter, txId })).digest('hex').slice(0, 32);
  const intent = { txId, payerDeviceId: id, payeeDeviceId: att.deviceId, amountMinor, currency: 'PEN', payerAmountMinor: amountMinor, payerCurrency: 'PEN', rateMicros: 1000000, marginBps: 0, rateSnapshotId: rates.id, token, arqc, counter, channel: 'ble', ts: Date.now(), nonce: randomBytes(8).toString('hex'), keyEpoch: 1 };
  const voucher = { intent, payerSig: sig(d.pem, canonical(intent)) };
  console.log('POST /v1/authorize-offline →', JSON.stringify(await post('/v1/authorize-offline', voucher)));
  console.log('POST /v1/authorize-offline (reenvío idempotente) →', JSON.stringify(await post('/v1/authorize-offline', voucher)));
} else {
  console.error('uso: sign.mjs new|attest|op|forensic|emv|pay'); process.exit(2);
}
