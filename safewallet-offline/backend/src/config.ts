import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPair, randomHex, type KeyPair } from './util/crypto.js';

/** Secret manager (mock): `<NAME>_FILE` (docker/k8s secrets) > variable de entorno > archivo local generado (solo no-producción). */
export interface Secrets { masterSecret: Buffer; server: KeyPair }

export interface Config {
  env: string;
  port: number;
  host: string;
  databaseUrl?: string;
  redisUrl?: string;
  sandboxApiKey: string;
  allowedBuildIds: string[];
  offlineDailyLimitUsdMinor: number;
  offlinePerTxLimitUsdMinor: number;
  maxOfflineLimitUsdMinor: number;
  rateMarginBps: number;
  riskStepUpThreshold: number;
  voucherMaxAgeMs: number;
  sweepIntervalMs: number;
  secretsFile: string;
  webhookAllowPrivate: boolean;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido en configuración: ${v}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    env: env.NODE_ENV ?? 'development',
    port: num(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || undefined,
    sandboxApiKey: env.SANDBOX_API_KEY ?? 'sw_sandbox_demo_key',
    allowedBuildIds: (env.ALLOWED_BUILD_IDS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
    offlineDailyLimitUsdMinor: num(env.OFFLINE_DAILY_LIMIT_USD_MINOR, 20000),
    offlinePerTxLimitUsdMinor: num(env.OFFLINE_PER_TX_LIMIT_USD_MINOR, 10000),
    maxOfflineLimitUsdMinor: num(env.MAX_OFFLINE_LIMIT_USD_MINOR, 100000),
    rateMarginBps: num(env.RATE_MARGIN_BPS, 200),
    riskStepUpThreshold: num(env.RISK_STEP_UP_THRESHOLD, 70),
    voucherMaxAgeMs: num(env.VOUCHER_MAX_AGE_HOURS, 168) * 3600_000,
    sweepIntervalMs: num(env.SWEEP_INTERVAL_SECONDS, 60) * 1000,
    secretsFile: env.SECRETS_FILE ?? './.data/secrets.json',
    webhookAllowPrivate: (env.WEBHOOK_ALLOW_PRIVATE ?? ((env.NODE_ENV ?? 'development') === 'production' ? 'false' : 'true')) === 'true',
  };
}

function readSecret(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const f = env[`${name}_FILE`];
  if (f) {
    if (!existsSync(f)) throw new Error(`${name}_FILE apunta a un archivo inexistente: ${f}`);
    return readFileSync(f, 'utf8').trim();
  }
  return env[name] || undefined;
}

export function loadSecrets(cfg: Config, env: NodeJS.ProcessEnv = process.env): Secrets {
  const master = readSecret('MASTER_SECRET', env);
  const priv = readSecret('SERVER_SIGNING_KEY_PEM_B64', env);
  const pub = readSecret('SERVER_SIGNING_PUBLIC_KEY', env);
  if (master && priv && pub) {
    if (!/^[0-9a-f]{64}$/i.test(master)) throw new Error('MASTER_SECRET debe ser hex de 32 bytes (64 caracteres)');
    return { masterSecret: Buffer.from(master, 'hex'), server: { publicKey: pub, privateKeyPem: Buffer.from(priv, 'base64').toString('utf8') } };
  }
  if (cfg.env === 'production') {
    throw new Error('En producción MASTER_SECRET, SERVER_SIGNING_KEY_PEM_B64 y SERVER_SIGNING_PUBLIC_KEY son obligatorios (o sus variantes *_FILE).');
  }
  // Modo desarrollo: secret manager local persistente (permisos 0600) para que los reinicios no invaliden tokens.
  if (existsSync(cfg.secretsFile)) {
    const j = JSON.parse(readFileSync(cfg.secretsFile, 'utf8')) as { master: string; pub: string; priv: string };
    return { masterSecret: Buffer.from(j.master, 'hex'), server: { publicKey: j.pub, privateKeyPem: j.priv } };
  }
  const server = generateKeyPair();
  const m = randomHex(32);
  mkdirSync(dirname(cfg.secretsFile), { recursive: true });
  writeFileSync(cfg.secretsFile, JSON.stringify({ master: m, pub: server.publicKey, priv: server.privateKeyPem }), { mode: 0o600 });
  chmodSync(cfg.secretsFile, 0o600);
  return { masterSecret: Buffer.from(m, 'hex'), server };
}
