import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { loadConfig, loadSecrets, type Config, type Secrets } from './config.js';
import { MemoryKV, RedisKV, type KV } from './db/kv.js';
import { MemoryStore, type Store } from './db/store.js';
import { PgStore } from './db/pg-store.js';
import { makeCtx, type Ctx } from './ctx.js';
import { ensureSandboxTenants } from './services/tenants.js';
import { ensureRates } from './services/rates.js';

export interface Runtime { ctx: Ctx; cfg: Config }

export async function createRuntime(over: { cfg?: Partial<Config>; secrets?: Secrets; store?: Store; kv?: KV; logger?: FastifyBaseLogger; now?: () => number; adminKey?: string } = {}): Promise<Runtime> {
  const cfg = { ...loadConfig(), ...over.cfg };
  const log = over.logger ?? (pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers["x-api-key"]', '*.pan', '*.pin'] }) as unknown as FastifyBaseLogger);
  const secrets = over.secrets ?? loadSecrets(cfg);
  let store = over.store;
  if (!store) {
    if (cfg.databaseUrl) { const pg = new PgStore(cfg.databaseUrl); await pg.migrate(); store = pg; log.info('almacenamiento: PostgreSQL'); }
    else { store = new MemoryStore(); log.warn('DATABASE_URL no definido: usando almacenamiento en memoria (solo desarrollo/tests)'); }
  }
  const kv = over.kv ?? (cfg.redisUrl ? new RedisKV(cfg.redisUrl) : new MemoryKV(over.now));
  if (!cfg.redisUrl && !over.kv) log.warn('REDIS_URL no definido: usando KV en memoria (solo desarrollo/tests)');
  const ctx = makeCtx({ cfg, secrets, store, kv, log, now: over.now });
  const adminKey = over.adminKey ?? process.env.ADMIN_API_KEY ?? (cfg.env === 'production' ? undefined : 'sw_admin_demo_key');
  await ensureSandboxTenants(ctx, adminKey);
  await ensureRates(ctx);
  return { ctx, cfg };
}
