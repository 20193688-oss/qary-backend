import type { Ctx } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { ecdsaVerify, hashPin, pubToKey, randomHex, sha256Hex, wrapFor } from '../util/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../util/errors.js';
import type { Device, DeviceStatus, Profile, Tenant } from '../types.js';
import { ensureRates } from './rates.js';

const DAY = 86_400_000;
const LICENSE_MS = 30 * DAY;
const KEY_ROTATION_MS = DAY;

export interface AttestationStatement {
  nonce: string; publicKey: string; platform: 'android' | 'ios' | 'sandbox'; buildId: string; appHash: string;
  rooted: boolean; emulator: boolean; hooked: boolean; debuggable: boolean; integrityToken: string; ts: number;
}

export async function issueChallenge(ctx: Ctx): Promise<{ challenge: string; expiresInSec: number }> {
  const challenge = randomHex(16);
  await ctx.kv.set(`challenge:${challenge}`, '1', 300);
  return { challenge, expiresInSec: 300 };
}

export const deviceIdFor = (publicKey: string): string => sha256Hex(Buffer.from(publicKey, 'base64url')).slice(0, 32);

export async function getDevice(ctx: Ctx, id: string, tenant?: Tenant): Promise<Device> {
  const d = await ctx.store.get<Device>('devices', id);
  if (!d || (tenant && !tenant.admin && d.tenantId !== tenant.id)) throw notFound('device_not_found', 'dispositivo no encontrado');
  return d;
}

export async function saveDevice(ctx: Ctx, d: Device): Promise<void> { await ctx.store.put('devices', d.id, d); }

/** Claves simétricas por dispositivo derivadas del secreto maestro: nunca se almacenan (HKDF). */
export const ledgerKey = (ctx: Ctx, deviceId: string, epoch: number): Buffer => ctx.derive(deviceId, `ledger-mac|${epoch}`);
export const smsKey = (ctx: Ctx, deviceId: string, epoch: number): Buffer => ctx.derive(deviceId, `sms|${epoch}`);
export const lukFor = (ctx: Ctx, deviceId: string, token: string, epoch: number): Buffer => ctx.derive(deviceId, `luk|${token}|${epoch}`);

/** Certificado de dispositivo firmado por el servidor: permite a dos teléfonos verificarse sin red. */
export function deviceCertificate(ctx: Ctx, d: Device): { deviceId: string; publicKey: string; expiresAt: number; sig: string } {
  const body = { deviceId: d.id, publicKey: d.publicKey, expiresAt: d.licenseExpiresAt };
  return { ...body, sig: ctx.signServer(canonical(body)) };
}

export function keyBundle(ctx: Ctx, d: Device): { epoch: number; issuedAt: number; expiresAt: number; wrapped: ReturnType<typeof wrapFor> } {
  const issuedAt = ctx.now();
  const plain = canonical({
    epoch: d.keyEpoch,
    ledgerKey: ledgerKey(ctx, d.id, d.keyEpoch).toString('base64url'),
    smsKey: smsKey(ctx, d.id, d.keyEpoch).toString('base64url'),
  });
  return { epoch: d.keyEpoch, issuedAt, expiresAt: issuedAt + KEY_ROTATION_MS, wrapped: wrapFor(d.publicKey, Buffer.from(plain), `sw-keys|${d.id}|${d.keyEpoch}`) };
}

export async function attest(ctx: Ctx, tenant: Tenant, req: { statement: AttestationStatement; signature: string; clientIp?: string }) {
  const st = req.statement;
  const nonceOk = await ctx.kv.take(`challenge:${st.nonce}`);
  if (!nonceOk) throw badRequest('challenge_invalid', 'challenge inexistente, vencido o ya usado');
  pubToKey(st.publicKey); // valida punto en curva
  if (!ecdsaVerify(st.publicKey, canonical(st), req.signature)) throw badRequest('attestation_signature_invalid', 'la firma de la attestation no corresponde a la clave del dispositivo');
  if (Math.abs(ctx.now() - st.ts) > 10 * 60_000) throw badRequest('attestation_stale', 'attestation fuera de ventana de tiempo');

  const reasons: string[] = [];
  if (st.rooted) reasons.push('rooted');
  if (st.emulator) reasons.push('emulator');
  if (st.hooked) reasons.push('hooking_framework');
  if (st.debuggable) reasons.push('debuggable');
  if (!(await verifyPlatformToken(ctx, st))) reasons.push('platform_integrity_failed');
  const build = await ctx.store.get<{ buildId: string; appHash: string; revoked?: boolean }>('builds', st.buildId);
  const anyBuild = ctx.cfg.allowedBuildIds.includes('*');
  if (build) {
    if (build.revoked) reasons.push('build_revoked');
    if (build.appHash !== st.appHash) reasons.push('app_hash_mismatch');
  } else if (!anyBuild && !ctx.cfg.allowedBuildIds.includes(st.buildId)) {
    reasons.push('unknown_build');
  }

  const id = deviceIdFor(st.publicKey);
  const existing = await ctx.store.get<Device>('devices', id);
  if (existing && existing.tenantId !== tenant.id) throw conflict('device_owned_elsewhere', 'el dispositivo ya está registrado por otro cliente');
  const device: Device = existing ?? {
    id, tenantId: tenant.id, publicKey: st.publicKey, platform: st.platform, buildId: st.buildId, trusted: false, trustReasons: [],
    status: 'active', decoy: false, keyEpoch: 1, minKeyEpoch: 1, licenseExpiresAt: 0, lastCounter: 0, lastEntryHash: '0'.repeat(64),
    lastEntrySeq: -1, sessionEpoch: 1, pendingCommands: [], createdAt: ctx.now(),
  };
  device.buildId = st.buildId;
  device.platform = st.platform;
  device.trusted = reasons.length === 0;
  device.trustReasons = reasons;
  device.licenseExpiresAt = ctx.now() + LICENSE_MS;
  await saveDevice(ctx, device);
  if (!existing) await ctx.store.put('wallets', id, { deviceId: id, balances: {} });
  await ctx.appendLog(`dev:${id}`, 'attestation', { trusted: device.trusted, reasons, buildId: st.buildId });
  if (!device.trusted) await ctx.emit(tenant.id, 'device.untrusted', { deviceId: id, reasons });
  const snap = await ensureRates(ctx);
  return {
    certificate: deviceCertificate(ctx, device),
    deviceId: id, trusted: device.trusted, reasons, status: device.status, licenseExpiresAt: device.licenseExpiresAt,
    serverPublicKey: ctx.secrets.server.publicKey, keys: keyBundle(ctx, device), rates: snap,
  };
}

/** Verificador de integridad de plataforma. Mock determinista: acepta `MOCK-OK-*` y sandbox. Reemplazable por Play Integrity / DeviceCheck. */
async function verifyPlatformToken(_ctx: Ctx, st: AttestationStatement): Promise<boolean> {
  if (st.platform === 'sandbox') return st.integrityToken.startsWith('MOCK-OK');
  return st.integrityToken.startsWith('MOCK-OK'); // límite documentado en docs/SECURITY.md
}

export async function rotateKeys(ctx: Ctx, deviceId: string, tenant: Tenant, req: { ts: number; signature: string }, reason: 'schedule' | 'risk' = 'schedule') {
  const d = await getDevice(ctx, deviceId, tenant);
  if (!ecdsaVerify(d.publicKey, canonical({ op: 'rotate', deviceId, ts: req.ts }), req.signature) || Math.abs(ctx.now() - req.ts) > 5 * 60_000)
    throw forbidden('bad_signature', 'firma de rotación inválida');
  assertOperable(d);
  d.keyEpoch += 1;
  d.minKeyEpoch = reason === 'risk' ? d.keyEpoch : d.keyEpoch - 1;
  await saveDevice(ctx, d);
  await ctx.appendLog(`dev:${d.id}`, 'key_rotation', { epoch: d.keyEpoch, reason });
  return keyBundle(ctx, d);
}

export function assertOperable(d: Device): void {
  if (d.status !== 'active') throw forbidden('device_not_active', `dispositivo en estado ${d.status}`, { status: d.status });
  if (!d.trusted) throw forbidden('device_untrusted', 'el dispositivo no pasó la attestation', { reasons: d.trustReasons });
}

export async function setStatus(ctx: Ctx, d: Device, status: DeviceStatus, reason: string): Promise<void> {
  d.status = status;
  d.statusReason = reason;
  await saveDevice(ctx, d);
  await ctx.appendLog(`dev:${d.id}`, 'status_change', { status, reason });
}

export interface ProfileInput {
  phone?: string; pin?: string; duressPin?: string; email?: string;
  trustedContacts?: { name: string; phone: string }[];
  safeZone?: { lat: number; lon: number; radiusM: number };
  offlineDailyLimitUsdMinor?: number; offlinePerTxLimitUsdMinor?: number;
  countryLimitsUsdMinor?: Record<string, number>; whitelistMerchants?: string[]; deadmanHours?: number;
}

export async function getProfile(ctx: Ctx, deviceId: string): Promise<Profile> {
  const p = await ctx.store.get<Profile>('profiles', deviceId);
  if (p) return p;
  return {
    deviceId, trustedContacts: [], offlineDailyLimitUsdMinor: ctx.cfg.offlineDailyLimitUsdMinor,
    offlinePerTxLimitUsdMinor: ctx.cfg.offlinePerTxLimitUsdMinor, countryLimitsUsdMinor: {}, whitelistMerchants: [],
    lastProofOfLife: ctx.now(), userRef: 'u_' + sha256Hex(deviceId).slice(0, 16),
  };
}

export async function updateProfile(ctx: Ctx, deviceId: string, tenant: Tenant, input: ProfileInput): Promise<Omit<Profile, 'pinHash' | 'duressPinHash'>> {
  const d = await getDevice(ctx, deviceId, tenant);
  const p = await getProfile(ctx, d.id);
  if (input.pin !== undefined) {
    if (!/^\d{4,8}$/.test(input.pin)) throw badRequest('bad_pin', 'el PIN debe tener 4 a 8 dígitos');
    p.pinHash = hashPin(input.pin);
  }
  if (input.duressPin !== undefined) {
    if (!/^\d{4,8}$/.test(input.duressPin)) throw badRequest('bad_pin', 'el PIN de coacción debe tener 4 a 8 dígitos');
    if (input.pin !== undefined && input.pin === input.duressPin) throw badRequest('bad_pin', 'el PIN de coacción debe ser distinto del PIN real');
    p.duressPinHash = hashPin(input.duressPin);
  }
  if (input.phone !== undefined) {
    if (!/^\+\d{8,15}$/.test(input.phone)) throw badRequest('bad_phone', 'teléfono en formato E.164 (+51999999999)');
    const owners = await ctx.store.find<{ deviceId: string }>('phones', { phone: input.phone });
    if (owners.length && owners[0].deviceId !== d.id) throw conflict('phone_in_use', 'el teléfono ya está asociado a otro dispositivo');
    await ctx.store.put('phones', input.phone, { phone: input.phone, deviceId: d.id });
    p.phone = input.phone;
  }
  if (input.email !== undefined) p.email = input.email;
  if (input.trustedContacts) {
    for (const c of input.trustedContacts) if (!/^\+\d{8,15}$/.test(c.phone)) throw badRequest('bad_phone', `contacto de confianza con teléfono inválido: ${c.name}`);
    p.trustedContacts = input.trustedContacts;
  }
  if (input.safeZone) p.safeZone = input.safeZone;
  if (input.offlineDailyLimitUsdMinor !== undefined) {
    if (input.offlineDailyLimitUsdMinor > ctx.cfg.maxOfflineLimitUsdMinor) throw badRequest('limit_too_high', `el límite offline máximo es ${ctx.cfg.maxOfflineLimitUsdMinor} (USD minor)`);
    p.offlineDailyLimitUsdMinor = input.offlineDailyLimitUsdMinor;
  }
  if (input.offlinePerTxLimitUsdMinor !== undefined) p.offlinePerTxLimitUsdMinor = Math.min(input.offlinePerTxLimitUsdMinor, p.offlineDailyLimitUsdMinor);
  if (input.countryLimitsUsdMinor) p.countryLimitsUsdMinor = input.countryLimitsUsdMinor;
  if (input.whitelistMerchants) p.whitelistMerchants = input.whitelistMerchants;
  if (input.deadmanHours !== undefined) p.deadmanHours = input.deadmanHours;
  p.lastProofOfLife = ctx.now();
  await ctx.store.put('profiles', d.id, p);
  const { pinHash: _a, duressPinHash: _b, ...pub } = p;
  return pub;
}

/**
 * Detección de clonación: el mismo device-id visto en dos IPs distintas y geos incompatibles (> 100 km) dentro de 15 minutos
 * bloquea el dispositivo y avisa al tenant.
 */
export async function observeSighting(ctx: Ctx, d: Device, s: { ip?: string; lat?: number; lon?: number }): Promise<boolean> {
  if (!s.ip) return false;
  const prev = await ctx.store.get<{ ip: string; lat?: number; lon?: number; ts: number }>('sightings', d.id);
  const cur = { ip: s.ip, lat: s.lat, lon: s.lon, ts: ctx.now() };
  let cloned = false;
  if (prev && prev.ip !== s.ip && cur.ts - prev.ts < 15 * 60_000) {
    if (prev.lat !== undefined && prev.lon !== undefined && s.lat !== undefined && s.lon !== undefined) {
      cloned = haversineM(prev.lat, prev.lon, s.lat, s.lon) > 100_000;
    }
  }
  await ctx.store.put('sightings', d.id, cur);
  if (cloned) {
    await setStatus(ctx, d, 'blocked', 'clone_suspected');
    await ctx.emit(d.tenantId, 'device.clone_suspected', { deviceId: d.id, ips: [prev!.ip, s.ip] });
  }
  return cloned;
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000; const rad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function registerBuild(ctx: Ctx, buildId: string, appHash: string): Promise<void> {
  await ctx.store.put('builds', buildId, { buildId, appHash });
}
