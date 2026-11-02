import type { Ctx } from '../ctx.js';
import { randomHex, sha256Hex } from '../util/crypto.js';
import type { Plan, Tenant } from '../types.js';

export const PLAN_FEATURES: Record<Plan, string[]> = {
  starter: ['tokenize', 'attest', 'rates'],
  pro: ['tokenize', 'attest', 'rates', 'authorize', 'reconcile', 'panic', 'qr', 'sms', 'reports', 'forensic', 'webhooks', 'risk'],
  enterprise: ['tokenize', 'attest', 'rates', 'authorize', 'reconcile', 'panic', 'qr', 'sms', 'reports', 'forensic', 'webhooks', 'risk', 'on_prem', 'sla'],
};
export const PLAN_RATE_LIMIT_PER_MIN: Record<Plan, number> = { starter: 120, pro: 600, enterprise: 6000 };
export const PLAN_CATALOG = [
  { plan: 'starter', priceUsdMonth: 499, includes: 'SDK de tokenización + attestation', features: PLAN_FEATURES.starter, rateLimitPerMin: 120 },
  { plan: 'pro', priceUsdMonth: 2499, includes: 'SDK + Protocolo Escudo + doble agente', features: PLAN_FEATURES.pro, rateLimitPerMin: 600 },
  { plan: 'enterprise', priceUsdMonth: null, includes: 'SDK + backend on-prem + auditoría forense + SLA (precio a medida)', features: PLAN_FEATURES.enterprise, rateLimitPerMin: 6000 },
];

export const keyHash = (k: string): string => sha256Hex('sw-api-key|' + k);

export async function createTenant(ctx: Ctx, name: string, plan: Plan, apiKey?: string, admin = false): Promise<{ tenant: Tenant; apiKey: string }> {
  const key = apiKey ?? `sw_live_${randomHex(24)}`;
  const tenant: Tenant = { id: 't_' + randomHex(6), name, plan, apiKeyHash: keyHash(key), webhookSecret: randomHex(24), createdAt: ctx.now(), ...(admin ? { admin: true } : {}) };
  await ctx.store.put('tenants', tenant.id, tenant);
  await ctx.store.put('tenant_keys', tenant.apiKeyHash, { tenantId: tenant.id });
  return { tenant, apiKey: key };
}

export async function tenantByKey(ctx: Ctx, key: string): Promise<Tenant | undefined> {
  const ref = await ctx.store.get<{ tenantId: string }>('tenant_keys', keyHash(key));
  return ref ? ctx.store.get<Tenant>('tenants', ref.tenantId) : undefined;
}

/** Crea los tenants de sandbox/admin si no existen (idempotente). */
export async function ensureSandboxTenants(ctx: Ctx, adminKey?: string): Promise<void> {
  if (!(await tenantByKey(ctx, ctx.cfg.sandboxApiKey))) await createTenant(ctx, 'Sandbox público', 'pro', ctx.cfg.sandboxApiKey);
  if (adminKey && !(await tenantByKey(ctx, adminKey))) await createTenant(ctx, 'Administración', 'enterprise', adminKey, true);
}
