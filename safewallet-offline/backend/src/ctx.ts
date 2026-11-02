import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config, Secrets } from './config.js';
import type { KV } from './db/kv.js';
import { withLock } from './db/kv.js';
import type { Store } from './db/store.js';
import { canonical } from './util/canonical.js';
import { ecdsaSign, ecdsaVerify, GENESIS_HASH, hkdf, randomHex, sha256Hex } from './util/crypto.js';
import { badRequest } from './util/errors.js';
import { isIP } from 'node:net';

export interface Ctx {
  cfg: Config;
  secrets: Secrets;
  store: Store;
  kv: KV;
  log: FastifyBaseLogger;
  now(): number;
  lock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  signServer(data: string): string;
  derive(salt: string, info: string, len?: number): Buffer;
  appendLog(chain: string, type: string, data: Record<string, unknown>): Promise<LogRecord>;
  enqueue(m: OutboxInput): Promise<OutboxMsg>;
  emit(tenantId: string, event: string, data: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
}

export interface OutboxInput { kind: 'sms' | 'email'; to: string; body: string; deviceId: string; tenantId: string; silent?: boolean }
export interface LogRecord {
  chain: string; index: number; type: string; ts: number;
  data: Record<string, unknown>; prevHash: string; hash: string; sig: string;
  [k: string]: unknown;
}
export interface OutboxMsg {
  id: string; kind: 'sms' | 'email'; to: string; body: string; deviceId: string; tenantId: string;
  silent?: boolean; sig: string; status: 'queued' | 'sent'; createdAt: number;
  [k: string]: unknown;
}

export function logHash(r: Pick<LogRecord, 'chain' | 'index' | 'type' | 'ts' | 'data' | 'prevHash'>): string {
  return sha256Hex(canonical({ chain: r.chain, index: r.index, type: r.type, ts: r.ts, data: r.data, prevHash: r.prevHash }));
}

/** Verifica una cadena append-only: enlaces, hashes y firma del servidor. Devuelve el primer índice roto o -1. */
export function verifyLogChain(records: LogRecord[], serverPub: string): number {
  let prev = GENESIS_HASH;
  for (const r of records) {
    if (r.prevHash !== prev || r.hash !== logHash(r) || !ecdsaVerify(serverPub, r.hash, r.sig)) return r.index;
    prev = r.hash;
  }
  return -1;
}

function privateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  return false;
}

export function makeCtx(p: { cfg: Config; secrets: Secrets; store: Store; kv: KV; log: FastifyBaseLogger; now?: () => number }): Ctx {
  const now = p.now ?? Date.now;
  const pending = new Set<Promise<unknown>>();
  const ctx: Ctx = {
    cfg: p.cfg, secrets: p.secrets, store: p.store, kv: p.kv, log: p.log, now,
    lock: (name, fn) => withLock(p.kv, name, fn),
    signServer: (d) => ecdsaSign(p.secrets.server.privateKeyPem, d),
    derive: (salt, info, len = 32) => hkdf(p.secrets.masterSecret, salt, info, len),
    async appendLog(chain, type, data) {
      return withLock(p.kv, `chain:${chain}`, async () => {
        const head = await p.store.get<{ index: number; hash: string }>('log_heads', chain);
        const index = head ? head.index + 1 : 0;
        const prevHash = head ? head.hash : GENESIS_HASH;
        const base = { chain, index, type, ts: now(), data, prevHash };
        const hash = logHash(base);
        const rec: LogRecord = { ...base, hash, sig: ctx.signServer(hash) };
        await p.store.put(`log:${chain}`, String(index).padStart(10, '0'), rec);
        await p.store.put('log_heads', chain, { index, hash });
        return rec;
      });
    },
    async enqueue(m) {
      const id = randomHex(8);
      const base = { ...m, id, status: 'queued' as const, createdAt: now() };
      const msg: OutboxMsg = { ...base, sig: ctx.signServer(sha256Hex(canonical({ id, to: m.to, body: m.body }))) };
      await p.store.put('outbox', id, msg);
      return msg;
    },
    async emit(tenantId, event, data) {
      type Sub = { id: string; tenantId: string; url: string; secret: string; events: string[] };
      // tenantId '*' = difusión (p. ej. identity.compromised): solo suscriptores que piden el evento explícitamente.
      const subs = tenantId === '*' ? await p.store.list<Sub>('webhook_subs') : await p.store.find<Sub>('webhook_subs', { tenantId });
      for (const s of subs) {
        if (!s.events.includes(event) && !(tenantId !== '*' && s.events.includes('*'))) continue;
        const body = canonical({ id: randomHex(8), event, ts: now(), data });
        const ts = String(now());
        const sig = createHmac('sha256', s.secret).update(`${ts}.${body}`).digest('hex');
        const job = (async () => {
          let status = 0; let error: string | undefined;
          try {
            const u = new URL(s.url);
            if (!['http:', 'https:'].includes(u.protocol)) throw new Error('esquema no permitido');
            if (!p.cfg.webhookAllowPrivate && privateHost(u.hostname)) throw new Error('destino privado bloqueado (SSRF)');
            const res = await fetch(s.url, {
              method: 'POST', body, signal: AbortSignal.timeout(5000),
              headers: { 'content-type': 'application/json', 'x-sw-timestamp': ts, 'x-sw-signature': `v1=${sig}`, 'x-sw-event': event },
            });
            status = res.status;
          } catch (e) {
            error = (e as Error).message;
            p.log.warn({ sub: s.id, event, err: error }, 'entrega de webhook fallida');
          }
          await p.store.put('webhook_deliveries', randomHex(8), { subId: s.id, tenantId, event, status, error: error ?? null, ts: now() });
        })();
        pending.add(job);
        void job.finally(() => pending.delete(job));
      }
    },
    async flush() { await Promise.allSettled([...pending]); },
  };
  return ctx;
}

export function requireInt(v: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw badRequest('invalid_field', `${name} debe ser un entero entre ${min} y ${max}`);
  return v;
}
