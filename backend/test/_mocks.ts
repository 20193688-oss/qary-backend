import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

type Row = Record<string, unknown> & { id?: string };

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const rv = row[k];
    if (v === null) { if (rv != null) return false; }
    else if (rv !== v) return false;
  }
  return true;
}

export function createInMemoryPrisma(): PrismaClient {
  const tables: Record<string, Row[]> = {
    user: [],
    refreshToken: [],
    order: [],
    payment: [],
    incident: [],
    mediaAsset: [],
    receipt: [],
    event: [],
    driver: [],
  };

  const model = (name: string) => {
    const arr = () => tables[name]!;
    return {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return arr().find((r) => matches(r, where)) ?? null;
      },
      async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
        if (!where) return arr()[0] ?? null;
        // soporte naive para `payload: { path: [...], equals: ... }`
        return arr().find((r) => {
          for (const [k, v] of Object.entries(where)) {
            if (v && typeof v === 'object' && 'path' in v && 'equals' in (v as Record<string, unknown>)) {
              const path = (v as { path: string[] }).path;
              const expected = (v as { equals: unknown }).equals;
              let cur: unknown = r[k];
              for (const seg of path) {
                if (!cur || typeof cur !== 'object') { cur = undefined; break; }
                cur = (cur as Record<string, unknown>)[seg];
              }
              if (cur !== expected) return false;
            } else if (r[k] !== v) {
              return false;
            }
          }
          return true;
        }) ?? null;
      },
      async findMany({ where }: { where?: Record<string, unknown> } = {}) {
        if (!where) return [...arr()];
        return arr().filter((r) => matches(r, where));
      },
      async create({ data }: { data: Row }) {
        const row = { id: data.id ?? randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
        arr().push(row);
        return row;
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const r = arr().find((x) => matches(x, where));
        if (!r) throw new Error(`update: ${name} not found`);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const rows = arr().filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
      async upsert({
        where, update, create,
      }: { where: Record<string, unknown>; update: Row; create: Row }) {
        const existing = arr().find((r) => matches(r, where));
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = { id: create.id ?? randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...create };
        arr().push(row);
        return row;
      },
      async delete({ where }: { where: Record<string, unknown> }) {
        const idx = arr().findIndex((r) => matches(r, where));
        if (idx < 0) throw new Error(`delete: ${name} not found`);
        const [removed] = arr().splice(idx, 1);
        return removed;
      },
    };
  };

  const prisma = {
    user: model('user'),
    refreshToken: model('refreshToken'),
    order: model('order'),
    payment: { ...model('payment'),
      async findUnique({ where, include }: { where: Record<string, unknown>; include?: { order?: boolean } }) {
        const r = tables.payment!.find((x) => matches(x, where));
        if (!r) return null;
        if (include?.order) {
          const order = tables.order!.find((o) => o.id === r.orderId);
          return { ...r, order };
        }
        return r;
      } },
    incident: model('incident'),
    mediaAsset: model('mediaAsset'),
    receipt: model('receipt'),
    event: model('event'),
    driver: model('driver'),
  } as unknown as PrismaClient;

  // Helper para inspeccionar tablas en tests
  (prisma as unknown as { __tables: typeof tables }).__tables = tables;
  return prisma;
}

export function createInMemoryRedis() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const isAlive = (key: string) => {
    const e = store.get(key);
    if (!e) return false;
    if (e.expiresAt && e.expiresAt < Date.now()) { store.delete(key); return false; }
    return true;
  };
  return {
    async get(key: string) { return isAlive(key) ? store.get(key)!.value : null; },
    async set(key: string, value: string, _ex?: string, ttl?: number) {
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : undefined });
      return 'OK';
    },
    async del(key: string) { return store.delete(key) ? 1 : 0; },
    async incr(key: string) {
      const cur = isAlive(key) ? Number(store.get(key)!.value) : 0;
      const next = cur + 1;
      const e = store.get(key);
      store.set(key, { value: String(next), expiresAt: e?.expiresAt });
      return next;
    },
    async expire(key: string, seconds: number) {
      const e = store.get(key);
      if (!e) return 0;
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async quit() { /* no-op */ return 'OK'; },
  } as unknown as import('ioredis').default;
}

export function createMockStripe() {
  type Intent = {
    id: string; amount: number; currency: string;
    status: string; client_secret: string;
    metadata: Record<string, string>;
  };
  const intents: Map<string, Intent> = new Map();
  let signatureValid = true;

  const stripe = {
    paymentIntents: {
      async create(args: { amount: number; currency: string; metadata?: Record<string, string> }) {
        const id = `pi_test_${Math.random().toString(36).slice(2, 10)}`;
        const intent: Intent = {
          id, amount: args.amount, currency: args.currency,
          status: 'requires_capture', client_secret: `${id}_secret_${randomUUID()}`,
          metadata: args.metadata ?? {},
        };
        intents.set(id, intent);
        return intent;
      },
      async capture(id: string) {
        const i = intents.get(id);
        if (!i) throw new Error('not_found');
        i.status = 'succeeded';
        return i;
      },
      async retrieve(id: string) { return intents.get(id) ?? null; },
    },
    webhooks: {
      constructEvent(body: Buffer, _sig: string, _secret: string) {
        if (!signatureValid) throw new Error('invalid signature');
        const text = body.toString('utf8');
        return JSON.parse(text);
      },
    },
    refunds: { async create() { return { id: 're_test_' + randomUUID(), status: 'succeeded' }; } },
    __intents: intents,
    __setSignatureValid(v: boolean) { signatureValid = v; },
  } as const;

  return stripe;
}
