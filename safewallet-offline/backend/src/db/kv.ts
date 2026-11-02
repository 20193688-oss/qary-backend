import { Redis } from 'ioredis';
import { randomHex } from '../util/crypto.js';

/** KV efímero: contadores (rate limit / anti fuerza bruta), nonces de un solo uso, locks distribuidos. */
export interface KV {
  /** Incrementa y fija TTL en el primer incremento. Devuelve el valor actual. */
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Atómico: true si la clave no existía. */
  setnx(key: string, value: string, ttlSec: number): Promise<boolean>;
  /** Lee y borra atómicamente (nonces de un solo uso). */
  take(key: string): Promise<string | undefined>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryKV implements KV {
  private m = new Map<string, { v: string; exp: number }>();
  constructor(private now: () => number = Date.now) {}
  private live(key: string) {
    const e = this.m.get(key);
    if (e && e.exp <= this.now()) { this.m.delete(key); return undefined; }
    return e;
  }
  async incr(key: string, ttlSec: number) {
    const e = this.live(key);
    if (!e) { this.m.set(key, { v: '1', exp: this.now() + ttlSec * 1000 }); return 1; }
    e.v = String(Number(e.v) + 1);
    return Number(e.v);
  }
  async get(key: string) { return this.live(key)?.v; }
  async set(key: string, value: string, ttlSec: number) { this.m.set(key, { v: value, exp: this.now() + ttlSec * 1000 }); }
  async setnx(key: string, value: string, ttlSec: number) {
    if (this.live(key)) return false;
    this.m.set(key, { v: value, exp: this.now() + ttlSec * 1000 });
    return true;
  }
  async take(key: string) { const e = this.live(key); this.m.delete(key); return e?.v; }
  async del(key: string) { this.m.delete(key); }
  async close() { /* nada */ }
}

export class RedisKV implements KV {
  private r: Redis;
  constructor(url: string) { this.r = new Redis(url, { maxRetriesPerRequest: 3 }); }
  async incr(key: string, ttlSec: number) {
    const n = await this.r.incr(key);
    if (n === 1) await this.r.expire(key, ttlSec);
    return n;
  }
  async get(key: string) { return (await this.r.get(key)) ?? undefined; }
  async set(key: string, value: string, ttlSec: number) { await this.r.set(key, value, 'EX', ttlSec); }
  async setnx(key: string, value: string, ttlSec: number) { return (await this.r.set(key, value, 'EX', ttlSec, 'NX')) === 'OK'; }
  async take(key: string) { return (await this.r.getdel(key)) ?? undefined; }
  async del(key: string) { await this.r.del(key); }
  /** Solo tests. */
  async flush() { await this.r.flushdb(); }
  async close() { await this.r.quit(); }
}

/** Lock distribuido simple con reintento (SET NX + TTL) y liberación por propietario. */
export async function withLock<T>(kv: KV, name: string, fn: () => Promise<T>, ttlSec = 15): Promise<T> {
  const key = `lock:${name}`;
  const owner = randomHex(8);
  const deadline = Date.now() + ttlSec * 1000;
  while (!(await kv.setnx(key, owner, ttlSec))) {
    if (Date.now() > deadline) throw new Error(`No se pudo obtener el lock ${name}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  try {
    return await fn();
  } finally {
    if ((await kv.get(key)) === owner) await kv.del(key);
  }
}
