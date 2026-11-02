import type { Ctx } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { ecdsaVerify, randomHex, sha256Hex, verifyPin } from '../util/crypto.js';
import { AppError, badRequest, forbidden } from '../util/errors.js';
import type { Device, Profile, Tenant } from '../types.js';
import { getDevice, getProfile, haversineM, observeSighting, saveDevice, setStatus } from './devices.js';
import { revokeTokens } from './tokenization.js';

const H72 = 72 * 3600_000;
/** El pánico firmado offline puede llegar horas después (cola local); es una acción de protección, así que tolera 7 días de antigüedad. */
const PANIC_MAX_AGE_MS = 7 * 86_400_000;

export interface RiskFlag {
  id: string; userRef: string; deviceId: string; reason: string; issuedAt: number; expiresAt: number; hash: string; sig: string;
  [k: string]: unknown;
}

export async function activeRiskFlag(ctx: Ctx, userRef: string): Promise<boolean> {
  return (await ctx.store.find<RiskFlag>('risk_flags', { userRef })).some((f) => f.expiresAt > ctx.now());
}

export async function getRiskFlag(ctx: Ctx, userRef: string) {
  const flags = (await ctx.store.find<RiskFlag>('risk_flags', { userRef })).filter((f) => f.expiresAt > ctx.now()).sort((a, b) => b.issuedAt - a.issuedAt);
  const f = flags[0];
  return f
    ? { userRef, atRisk: true, compromisedAccount: true, reason: f.reason, issuedAt: f.issuedAt, expiresAt: f.expiresAt, hash: f.hash, sig: f.sig, serverPublicKey: ctx.secrets.server.publicKey }
    : { userRef, atRisk: false, compromisedAccount: false, serverPublicKey: ctx.secrets.server.publicKey };
}

export async function issueRiskFlag(ctx: Ctx, d: Device, prof: Profile, reason: string): Promise<RiskFlag> {
  const issuedAt = ctx.now();
  const base = { id: 'rf_' + randomHex(8), userRef: prof.userRef, deviceId: d.id, reason, issuedAt, expiresAt: issuedAt + H72 };
  const hash = sha256Hex(canonical(base));
  const flag: RiskFlag = { ...base, hash, sig: ctx.signServer(hash) };
  await ctx.store.put('risk_flags', flag.id, flag);
  await ctx.appendLog('riskflags', 'risk_flag', { hash, userRef: prof.userRef, expiresAt: flag.expiresAt });
  return flag;
}

export type ShieldTrigger = 'button' | 'duress_pin' | 'sms' | 'remote_web' | 'deadman';

async function pinGate(ctx: Ctx, deviceId: string): Promise<void> {
  const n = Number((await ctx.kv.get(`pinfail:${deviceId}`)) ?? '0');
  if (n >= 5) throw new AppError('pin_locked', 429, 'demasiados PIN incorrectos; espera 15 minutos');
}
async function pinFail(ctx: Ctx, deviceId: string, what: string): Promise<never> {
  await ctx.kv.incr(`pinfail:${deviceId}`, 900);
  ctx.log.warn({ deviceId, what }, 'PIN incorrecto');
  throw forbidden('bad_pin', 'PIN incorrecto');
}

export interface ShieldRequest { deviceId: string; trigger: ShieldTrigger; pin?: string; ts?: number; signature?: string; location?: { lat: number; lon: number } }

export async function activateShield(ctx: Ctx, tenant: Tenant | undefined, req: ShieldRequest) {
  const d = tenant ? await getDevice(ctx, req.deviceId, tenant) : await ctx.store.get<Device>('devices', req.deviceId);
  if (!d) throw badRequest('device_not_found', 'dispositivo no encontrado');
  const prof = await getProfile(ctx, d.id);
  let duress = req.trigger === 'duress_pin';

  switch (req.trigger) {
    case 'button':
    case 'duress_pin': {
      if (!req.ts || !req.signature || req.ts > ctx.now() + 5 * 60_000 || ctx.now() - req.ts > PANIC_MAX_AGE_MS || !ecdsaVerify(d.publicKey, canonical({ op: 'panic', deviceId: d.id, ts: req.ts, trigger: req.trigger }), req.signature))
        throw forbidden('bad_signature', 'firma del dispositivo inválida o vencida');
      if (req.trigger === 'duress_pin') {
        await pinGate(ctx, d.id);
        if (!prof.duressPinHash || !req.pin || !verifyPin(req.pin, prof.duressPinHash)) return pinFail(ctx, d.id, 'duress');
      }
      break;
    }
    case 'sms':
    case 'remote_web': {
      await pinGate(ctx, d.id);
      if (!req.pin) throw badRequest('pin_required', 'se requiere PIN');
      const real = prof.pinHash && verifyPin(req.pin, prof.pinHash);
      const dur = prof.duressPinHash && verifyPin(req.pin, prof.duressPinHash);
      if (!real && !dur) return pinFail(ctx, d.id, req.trigger);
      duress = !!dur && !real;
      break;
    }
    case 'deadman':
      if (tenant) throw forbidden('internal_only', 'el testamento digital solo lo dispara el servidor');
      break;
    default:
      throw badRequest('bad_trigger', 'trigger desconocido');
  }
  await ctx.kv.del(`pinfail:${d.id}`);

  const already = d.status === 'shielded';
  const tokensRevoked = await revokeTokens(ctx, d.id, `shield:${req.trigger}`);
  if (!already) {
    d.keyEpoch += 1;                 // rotación por evento de riesgo: invalida MAC/ARQC/LUK anteriores
    d.minKeyEpoch = d.keyEpoch;
    d.sessionEpoch += 1;             // invalida sesiones
    d.pendingCommands = [...new Set([...d.pendingCommands, 'SE_WIPE', 'FREEZE_LEDGER', 'INVALIDATE_SESSIONS', ...(duress ? ['ENTER_DECOY'] : [])])];
  }
  d.decoy = d.decoy || duress;
  await saveDevice(ctx, d);
  if (!already) await setStatus(ctx, d, 'shielded', `shield:${req.trigger}`);

  const flag = already ? undefined : await issueRiskFlag(ctx, d, prof, `shield:${req.trigger}`);
  const loc = req.location ? ` Ubicación: https://maps.google.com/?q=${req.location.lat},${req.location.lon}` : '';
  const notified: string[] = [];
  if (!already) {
    const text = req.trigger === 'deadman'
      ? 'Mensaje automático de SafeWallet: no pude confirmar que estoy bien. Si te piden dinero en mi nombre, verifica por otra vía.'
      : 'Fui víctima de robo, no soy yo quien pide dinero. No transfieras ni respondas a mensajes o llamadas desde mis cuentas.';
    for (const c of prof.trustedContacts) {
      await ctx.enqueue({ kind: 'sms', to: c.phone, deviceId: d.id, tenantId: d.tenantId, silent: duress, body: `[SafeWallet Escudo] ${text}${loc}` });
      notified.push(c.phone);
    }
    if (prof.email) await ctx.enqueue({ kind: 'email', to: prof.email, deviceId: d.id, tenantId: d.tenantId, body: `Protocolo Escudo activado (${req.trigger}). Tokens revocados: ${tokensRevoked}. Riesgo de suplantación marcado por 72 h.` });
    await ctx.emit(d.tenantId, 'fraud.shield_activated', { deviceId: d.id, trigger: req.trigger, silent: duress });
    await ctx.emit('*', 'identity.compromised', { userRef: prof.userRef, expiresAt: flag!.expiresAt, hash: flag!.hash });
    await ctx.emit(d.tenantId, 'loan.block_requested', { userRef: prof.userRef, expiresAt: flag!.expiresAt });
  }
  await ctx.appendLog(`dev:${d.id}`, 'shield', { trigger: req.trigger, duress, already, tokensRevoked, location: req.location ? { latE6: Math.round(req.location.lat * 1e6), lonE6: Math.round(req.location.lon * 1e6) } : null });
  return {
    deviceId: d.id, status: d.status, trigger: req.trigger, silent: duress, alreadyShielded: already, tokensRevoked,
    commands: d.pendingCommands, notifiedContacts: notified.length,
    riskFlag: flag ? { id: flag.id, expiresAt: flag.expiresAt, hash: flag.hash } : null,
  };
}

export async function unlockDevice(ctx: Ctx, tenant: Tenant, deviceId: string, pin: string) {
  const d = await getDevice(ctx, deviceId, tenant);
  if (d.status !== 'locked') throw badRequest('not_locked', `el dispositivo está en estado ${d.status}; solo 'locked' se reactiva con PIN`);
  const prof = await getProfile(ctx, d.id);
  await pinGate(ctx, d.id);
  if (!prof.pinHash || !verifyPin(pin, prof.pinHash)) return pinFail(ctx, d.id, 'unlock');
  await ctx.kv.del(`pinfail:${d.id}`);
  await setStatus(ctx, d, 'active', 'unlocked_by_pin');
  return { deviceId: d.id, status: 'active' as const };
}

export async function checkLocation(ctx: Ctx, tenant: Tenant, deviceId: string, loc: { lat: number; lon: number; biometricRecent: boolean; ip?: string }) {
  const d = await getDevice(ctx, deviceId, tenant);
  const cloned = await observeSighting(ctx, d, { ip: loc.ip, lat: loc.lat, lon: loc.lon });
  const prof = await getProfile(ctx, d.id);
  let inside = true;
  let action: 'none' | 'locked' | 'clone_blocked' = cloned ? 'clone_blocked' : 'none';
  if (!cloned && prof.safeZone) {
    inside = haversineM(prof.safeZone.lat, prof.safeZone.lon, loc.lat, loc.lon) <= prof.safeZone.radiusM;
    if (!inside && !loc.biometricRecent) {
      const cur = (await ctx.store.get<Device>('devices', d.id))!;
      if (cur.status === 'active') {
        await setStatus(ctx, cur, 'locked', 'geofence_breach');
        if (prof.phone) await ctx.enqueue({ kind: 'sms', to: prof.phone, deviceId: d.id, tenantId: d.tenantId, body: 'SafeWallet: bloqueo preventivo, saliste de tu zona segura sin verificación biométrica.' });
        await ctx.emit(d.tenantId, 'fraud.geofence_breach', { deviceId: d.id });
      }
      action = 'locked';
    }
  }
  return { deviceId: d.id, inside, action };
}

export async function proofOfLife(ctx: Ctx, tenant: Tenant, deviceId: string, req: { ts: number; signature: string }) {
  const d = await getDevice(ctx, deviceId, tenant);
  if (Math.abs(ctx.now() - req.ts) > 10 * 60_000 || !ecdsaVerify(d.publicKey, canonical({ op: 'checkin', deviceId: d.id, ts: req.ts }), req.signature)) throw forbidden('bad_signature', 'firma inválida');
  const p = await getProfile(ctx, d.id);
  p.lastProofOfLife = ctx.now();
  await ctx.store.put('profiles', d.id, p);
  return { deviceId: d.id, lastProofOfLife: p.lastProofOfLife };
}

/** Testamento digital: si no hay prueba de vida dentro de `deadmanHours`, activa el Escudo. */
export async function sweepDeadman(ctx: Ctx): Promise<string[]> {
  const fired: string[] = [];
  for (const p of await ctx.store.list<Profile>('profiles', 100000)) {
    if (!p.deadmanHours) continue;
    const d = await ctx.store.get<Device>('devices', p.deviceId);
    if (!d || d.status === 'shielded') continue;
    if (ctx.now() - p.lastProofOfLife > p.deadmanHours * 3600_000) {
      await activateShield(ctx, undefined, { deviceId: d.id, trigger: 'deadman' });
      fired.push(d.id);
    }
  }
  return fired;
}

/** Maneja SMS entrante del gateway: "SAFE-SOS-<PIN>" enviado desde cualquier teléfono al número del usuario. */
export async function handleSosSms(ctx: Ctx, tenant: Tenant, msg: { to: string; from: string; body: string }) {
  const m = /^\s*SAFE-SOS-(\d{4,8})\s*$/i.exec(msg.body);
  if (!m) return undefined;
  const owner = await ctx.store.get<{ deviceId: string }>('phones', msg.to);
  if (!owner) throw badRequest('unknown_number', 'el número no está asociado a ningún dispositivo');
  return activateShield(ctx, tenant, { deviceId: owner.deviceId, trigger: 'sms', pin: m[1] });
}

/** Reporte de fraude entrante desde un banco/central de riesgo aliado (webhook firmado): marca riesgo y bloquea preventivamente. */
export async function reportFraud(ctx: Ctx, tenant: Tenant, r: { deviceId: string; source: string; kind: string; details?: string }) {
  const d = await getDevice(ctx, r.deviceId, tenant);
  const prof = await getProfile(ctx, d.id);
  const flag = await issueRiskFlag(ctx, d, prof, `partner:${r.source}:${r.kind}`);
  if (d.status === 'active') await setStatus(ctx, d, 'locked', `partner_fraud_report:${r.source}`);
  await ctx.appendLog(`dev:${d.id}`, 'partner_fraud_report', { source: r.source, kind: r.kind });
  await ctx.emit(d.tenantId, 'loan.block_requested', { userRef: prof.userRef, expiresAt: flag.expiresAt });
  return { deviceId: d.id, status: (await getDevice(ctx, d.id)).status, riskFlag: { id: flag.id, expiresAt: flag.expiresAt, hash: flag.hash } };
}
