import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from '../api/app.js';
import { canonical } from '../util/canonical.js';
import { ecdsaSign, generateKeyPair, hmacHex, randomHex, sha256Hex, unwrapWith, GENESIS_HASH, type KeyPair, type Wrapped } from '../util/crypto.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { loadConfig, type Secrets } from '../config.js';
import { MemoryKV, RedisKV, type KV } from '../db/kv.js';
import { PgStore } from '../db/pg-store.js';
import { MemoryStore, type Store } from '../db/store.js';
import { computeArqc } from '../services/tokenization.js';
import { entryHash } from '../services/payments.js';
import { crossRateMicros, payerPriceMinor, type RateSnapshot } from '../services/rates.js';
import { forensicHash } from '../services/forensic.js';
import type { Currency, Intent, LedgerEntry, Voucher } from '../types.js';
import { generateKeyPair as gen } from '../util/crypto.js';

export const API_KEY = 'sw_sandbox_test_key';
export const ADMIN_KEY = 'sw_admin_test_key';
export const H = { 'x-api-key': API_KEY, 'content-type': 'application/json' };
export const HA = { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' };

export interface Env { rt: Runtime; app: FastifyInstance; clock: { t: number }; close(): Promise<void> }

export async function makeEnv(over: { store?: Store; kv?: KV; cfg?: Record<string, unknown> } = {}): Promise<Env> {
  const clock = { t: Date.UTC(2026, 10, 2, 15, 0, 0) }; // 2026-11-02 10:00 Lima
  const now = () => clock.t;
  const server = gen();
  const secrets: Secrets = { masterSecret: Buffer.from(randomHex(32), 'hex'), server };
  let store = over.store; let kv = over.kv;
  if (!store && process.env.TEST_DATABASE_URL) {
    const pg = new PgStore(process.env.TEST_DATABASE_URL); await pg.migrate(); await pg.truncateAll(); store = pg;
  }
  if (!kv && process.env.TEST_REDIS_URL) { const r = new RedisKV(process.env.TEST_REDIS_URL); await r.flush(); kv = r; }
  const rt = await createRuntime({
    cfg: { ...loadConfig({ NODE_ENV: 'test', SANDBOX_API_KEY: API_KEY } as never), env: 'test', sandboxApiKey: API_KEY, ...over.cfg },
    secrets, store: store ?? new MemoryStore(), kv: kv ?? new MemoryKV(now),
    logger: pino({ level: process.env.TEST_LOG ?? 'silent' }) as unknown as FastifyBaseLogger, now, adminKey: ADMIN_KEY,
  });
  const app = await buildApp(rt.ctx, { logger: false });
  await app.ready();
  return { rt, app, clock, close: async () => { await app.close(); await rt.ctx.flush(); await rt.ctx.store.close(); await rt.ctx.kv.close(); } };
}

export async function call(env: Env, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = H) {
  const res = await env.app.inject({ method, url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, headers: res.headers };
}

let nonce = 0;
/** Cliente de referencia: lo que haría la app móvil con su Secure Element (aquí, claves en memoria). */
export class SimDevice {
  kp: KeyPair = generateKeyPair();
  id = '';
  epoch = 1;
  ledgerKey!: Buffer;
  smsKey!: Buffer;
  serverPub = '';
  rates!: RateSnapshot;
  lukByToken = new Map<string, Buffer>();
  tokens: string[] = [];
  seq = -1;
  counter = 0;
  prevHash = GENESIS_HASH;
  forensicIdx = -1;
  forensicPrev = GENESIS_HASH;
  entries: LedgerEntry[] = [];

  constructor(public env: Env, public flags: Partial<{ rooted: boolean; emulator: boolean; hooked: boolean; debuggable: boolean; integrityToken: string; buildId: string; appHash: string }> = {}) {}

  sign(data: string): string { return ecdsaSign(this.kp.privateKeyPem, data); }

  async register(): Promise<this> {
    const ch = await call(this.env, 'GET', '/v1/attest/challenge');
    const statement = {
      nonce: ch.body.challenge, publicKey: this.kp.publicKey, platform: 'sandbox' as const, buildId: this.flags.buildId ?? 'build-1', appHash: this.flags.appHash ?? 'h',
      rooted: !!this.flags.rooted, emulator: !!this.flags.emulator, hooked: !!this.flags.hooked, debuggable: !!this.flags.debuggable,
      integrityToken: this.flags.integrityToken ?? 'MOCK-OK-1', ts: this.env.clock.t,
    };
    const r = await call(this.env, 'POST', '/v1/attest', { statement, signature: this.sign(canonical(statement)) });
    if (r.status !== 200) throw new Error('attest falló: ' + JSON.stringify(r.body));
    this.id = r.body.deviceId; this.serverPub = r.body.serverPublicKey; this.rates = r.body.rates;
    this.applyKeys(r.body.keys);
    return this;
  }

  applyKeys(bundle: { epoch: number; wrapped: Wrapped }) {
    const plain = JSON.parse(unwrapWith(this.kp.privateKeyPem, bundle.wrapped, `sw-keys|${this.id}|${bundle.epoch}`).toString());
    this.epoch = plain.epoch;
    this.ledgerKey = Buffer.from(plain.ledgerKey, 'base64url');
    this.smsKey = Buffer.from(plain.smsKey, 'base64url');
  }

  async profile(p: Record<string, unknown>) { return call(this.env, 'PUT', `/v1/devices/${this.id}/profile`, p); }
  async fund(currency: Currency, amountMinor: number) { return call(this.env, 'POST', `/v1/devices/${this.id}/fund`, { currency, amountMinor }); }

  async tokenize(count = 5, pan = '4111111111111111') {
    const r = await call(this.env, 'POST', '/v1/tokenize', { deviceId: this.id, pan, expMonth: 12, expYear: 2030, currency: 'PEN', count });
    if (r.status !== 200) throw new Error('tokenize falló: ' + JSON.stringify(r.body));
    const luks = JSON.parse(unwrapWith(this.kp.privateKeyPem, r.body.lukBundle, `sw-luk|${this.id}`).toString()) as Record<string, string>;
    for (const [t, l] of Object.entries(luks)) { this.lukByToken.set(t, Buffer.from(l, 'base64url')); this.tokens.push(t); }
    return r.body;
  }

  /** Construye un voucher firmado + su entrada de ledger (PAY_OUT). */
  pay(o: { payee?: SimDevice; payeeRef?: string; amountMinor: number; currency: Currency; payerCurrency?: Currency; channel?: Intent['channel']; marginBps?: number; merchantRef?: string; geo?: Intent['geo']; stepUp?: Intent['stepUp']; nonce?: string; token?: string; counter?: number; tamper?: (i: Intent) => void; txId?: string; snapshot?: RateSnapshot }) {
    const snap = o.snapshot ?? this.rates;
    const payerCurrency = o.payerCurrency ?? 'PEN';
    const rate = o.currency === payerCurrency ? 1_000_000 : crossRateMicros(snap, payerCurrency, o.currency);
    const margin = o.marginBps ?? (o.currency === payerCurrency ? 0 : snap.marginBps);
    const token = o.token ?? this.tokens.shift()!;
    const counter = o.counter ?? this.counter + 1;
    const txId = o.txId ?? randomHex(12);
    const intent: Intent = {
      txId, payerDeviceId: this.id, ...(o.payee ? { payeeDeviceId: o.payee.id } : {}), ...(o.payeeRef ? { payeeRef: o.payeeRef } : {}),
      ...(o.merchantRef ? { merchantRef: o.merchantRef } : {}), amountMinor: o.amountMinor, currency: o.currency,
      payerAmountMinor: payerPriceMinor(o.amountMinor, rate, margin), payerCurrency, rateMicros: rate, marginBps: margin, rateSnapshotId: snap.id,
      token, arqc: computeArqc(this.lukByToken.get(token) ?? Buffer.alloc(32), { token, amountMinor: o.amountMinor, currency: o.currency, counter, txId }),
      counter, channel: o.channel ?? 'ble', ts: this.env.clock.t, nonce: o.nonce ?? randomHex(8), keyEpoch: this.epoch,
      ...(o.geo ? { geo: o.geo } : {}), ...(o.stepUp ? { stepUp: o.stepUp } : {}),
    };
    o.tamper?.(intent);
    const voucher: Voucher = { intent, payerSig: this.sign(canonical(intent)) };
    return { voucher, entry: this.appendEntry('PAY_OUT', { voucher }, counter) };
  }

  smsProof(txId: string): string { return hmacHex(this.smsKey, txId).slice(0, 16); }

  ack(txId: string) { return { payeeDeviceId: this.id, sig: this.sign(canonical({ txId, payeeDeviceId: this.id })) }; }

  receive(voucher: Voucher) {
    const v: Voucher = { ...voucher, payeeAck: this.ack(voucher.intent.txId) };
    return { voucher: v, entry: this.appendEntry('PAY_IN', { voucher: v }) };
  }

  appendEntry(type: LedgerEntry['type'], payload: Record<string, unknown>, counter?: number): LedgerEntry {
    this.seq += 1; this.counter = counter ?? this.counter + 1;
    const base = { seq: this.seq, counter: this.counter, prevHash: this.prevHash, keyEpoch: this.epoch, type, payload };
    const hash = entryHash(base);
    const e: LedgerEntry = { ...base, hash, mac: hmacHex(this.ledgerKey, hash), sig: this.sign(hash) };
    this.prevHash = hash; this.entries.push(e);
    return e;
  }

  reconcile(entries = this.entries) { return call(this.env, 'POST', '/v1/reconcile', { deviceId: this.id, entries }); }

  signedOp(op: string, extra: Record<string, unknown> = {}) {
    const ts = this.env.clock.t;
    return { ts, signature: this.sign(canonical({ op, deviceId: this.id, ts, ...extra })) };
  }

  forensicEntry(type: string, plaintext: string) {
    const index = this.forensicIdx + 1;
    const e = { index, type, ts: this.env.clock.t, ciphertext: Buffer.from(plaintext).toString('base64url'), prevHash: this.forensicPrev };
    const hash = forensicHash(this.id, e);
    this.forensicIdx = index; this.forensicPrev = hash;
    return { ...e, hash, sig: this.sign(hash) };
  }
}

export { sha256Hex };
