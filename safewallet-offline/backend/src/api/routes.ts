import type { Ctx } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { hmacHex, randomHex, safeEqualHex } from '../util/crypto.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import type { Tenant } from '../types.js';
import { CURRENCIES } from '../types.js';
import * as S from './schemas.js';
import { PLAN_CATALOG } from '../services/tenants.js';
import { attest, getDevice, issueChallenge, rotateKeys, updateProfile, registerBuild, assertOperable } from '../services/devices.js';
import { ecbSource, ensureRates, publishRates, refreshRates, staticReferenceSource } from '../services/rates.js';
import { provisionWallet, revokeCardTokens, tokenize } from '../services/tokenization.js';
import { authorizeOffline, fund, getWallet, reconcile, txHistory } from '../services/payments.js';
import { activateShield, checkLocation, getRiskFlag, proofOfLife, reportFraud, sweepDeadman, unlockDevice } from '../services/panic.js';
import { createDynamicQr, getQrStatus, parseEmv, routeEmvVoucher, verifyDynamicQr } from '../services/qr-interop.js';
import { handleInboundSms } from '../services/sms.js';
import { generateReport, sweepReports, PERIODS } from '../services/reports.js';
import { exportForensic, uploadForensic } from '../services/forensic.js';

export interface RouteReq { ctx: Ctx; tenant: Tenant; body: any; params: any; query: any; ip: string; headers: Record<string, string | string[] | undefined>; rawBody?: string }
export interface RouteDef {
  method: 'get' | 'post' | 'put';
  path: string;                // estilo OpenAPI: /v1/devices/{deviceId}
  summary: string;
  tag: string;
  feature?: string;            // función del plan requerida
  admin?: boolean;
  public?: boolean;
  status?: number;
  body?: S.Schema; params?: S.Schema; query?: S.Schema;
  ok: S.Schema;
  handler: (r: RouteReq) => Promise<unknown>;
}

const okObj = (props: Record<string, S.Schema>, required: string[]) => S.obj(props, required, true);
const sigBody = S.obj({ ts: S.int(), signature: S.b64() }, ['ts', 'signature']);

export const ROUTES: RouteDef[] = [
  { method: 'get', path: '/health', summary: 'Estado del servicio', tag: 'ops', public: true, ok: okObj({ status: S.str(), storage: S.str(), kv: S.str() }, ['status']), handler: async ({ ctx }) => ({ status: 'ok', time: ctx.now() }) },
  { method: 'get', path: '/v1/plans', summary: 'Planes SaaS B2B', tag: 'business', public: true, ok: okObj({ plans: S.arr(S.any) }, ['plans']), handler: async () => ({ plans: PLAN_CATALOG }) },

  // ---- attestation y dispositivos
  { method: 'get', path: '/v1/attest/challenge', summary: 'Obtiene un challenge de un solo uso para la attestation', tag: 'attest', feature: 'attest', ok: okObj({ challenge: S.str(), expiresInSec: S.int() }, ['challenge']), handler: ({ ctx }) => issueChallenge(ctx) },
  {
    method: 'post', path: '/v1/attest', summary: 'Registra/valida un dispositivo (attestation + licencia por dispositivo)', tag: 'attest', feature: 'attest',
    body: S.obj({
      statement: S.obj({ nonce: S.str(), publicKey: S.b64(), platform: { type: 'string', enum: ['android', 'ios', 'sandbox'] }, buildId: S.str(), appHash: S.str(), rooted: S.bool, emulator: S.bool, hooked: S.bool, debuggable: S.bool, integrityToken: S.str(), ts: S.int() },
        ['nonce', 'publicKey', 'platform', 'buildId', 'appHash', 'rooted', 'emulator', 'hooked', 'debuggable', 'integrityToken', 'ts']),
      signature: S.b64(),
    }, ['statement', 'signature']),
    ok: okObj({ deviceId: S.str(), trusted: S.bool, reasons: S.arr(S.str()), status: S.str(), licenseExpiresAt: S.int(), serverPublicKey: S.str(), certificate: S.any, keys: S.any, rates: S.rateSnapshot }, ['deviceId', 'trusted', 'status', 'serverPublicKey', 'certificate', 'keys', 'rates']),
    status: 200, handler: ({ ctx, tenant, body, ip }) => attest(ctx, tenant, { ...body, clientIp: ip }),
  },
  { method: 'get', path: '/v1/devices/{deviceId}', summary: 'Estado del dispositivo y comandos pendientes', tag: 'devices', feature: 'attest', params: S.deviceIdParam,
    ok: okObj({ deviceId: S.str(), status: S.str(), trusted: S.bool, pendingCommands: S.arr(S.str()), keyEpoch: S.int() }, ['deviceId', 'status', 'trusted']),
    handler: async ({ ctx, tenant, params }) => { const d = await getDevice(ctx, params.deviceId, tenant); return { deviceId: d.id, status: d.status, statusReason: d.statusReason ?? null, trusted: d.trusted, trustReasons: d.trustReasons, decoy: d.decoy, pendingCommands: d.pendingCommands, keyEpoch: d.keyEpoch, sessionEpoch: d.sessionEpoch, licenseExpiresAt: d.licenseExpiresAt, lastEntrySeq: d.lastEntrySeq, lastEntryHash: d.lastEntryHash }; } },
  { method: 'put', path: '/v1/devices/{deviceId}/profile', summary: 'Configura PIN, PIN de coacción, contactos de confianza, zona segura y límites', tag: 'devices', feature: 'attest', params: S.deviceIdParam,
    body: S.obj({
      phone: S.str(), email: S.str(), pin: S.str(), duressPin: S.str(),
      trustedContacts: S.arr(S.obj({ name: S.str(), phone: S.str() }, ['name', 'phone'])),
      safeZone: S.obj({ lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 }, radiusM: S.int({ minimum: 50 }) }, ['lat', 'lon', 'radiusM']),
      offlineDailyLimitUsdMinor: S.int({ minimum: 0 }), offlinePerTxLimitUsdMinor: S.int({ minimum: 0 }),
      countryLimitsUsdMinor: { type: 'object', additionalProperties: S.int({ minimum: 0 }) }, whitelistMerchants: S.arr(S.str()), deadmanHours: S.int({ minimum: 1, maximum: 720 }),
    }),
    ok: okObj({ deviceId: S.str(), userRef: S.str() }, ['deviceId', 'userRef']), handler: ({ ctx, tenant, params, body }) => updateProfile(ctx, params.deviceId, tenant, body) },
  { method: 'post', path: '/v1/devices/{deviceId}/keys/rotate', summary: 'Rota las claves simétricas del dispositivo (24 h o por evento de riesgo)', tag: 'devices', feature: 'attest', params: S.deviceIdParam, body: sigBody,
    ok: okObj({ epoch: S.int(), wrapped: S.wrapped }, ['epoch', 'wrapped']), handler: ({ ctx, tenant, params, body }) => rotateKeys(ctx, params.deviceId, tenant, body) },
  { method: 'post', path: '/v1/devices/{deviceId}/fund', summary: 'Sandbox: acredita saldo de prueba', tag: 'wallet', feature: 'attest', params: S.deviceIdParam,
    body: S.obj({ currency: S.currency, amountMinor: S.int({ minimum: 1 }) }, ['currency', 'amountMinor']),
    ok: okObj({ deviceId: S.str(), balances: S.any }, ['deviceId', 'balances']),
    handler: ({ ctx, tenant, params, body }) => { if (ctx.cfg.env === 'production') throw forbidden('sandbox_only', 'fund solo existe en sandbox'); return fund(ctx, tenant, params.deviceId, body.currency, body.amountMinor); } },
  { method: 'get', path: '/v1/devices/{deviceId}/wallet', summary: 'Saldos de la billetera', tag: 'wallet', feature: 'attest', params: S.deviceIdParam, ok: okObj({ deviceId: S.str(), balances: S.any }, ['deviceId', 'balances']), handler: ({ ctx, tenant, params }) => getWallet(ctx, params.deviceId, tenant) },
  { method: 'get', path: '/v1/devices/{deviceId}/transactions', summary: 'Historial de transacciones liquidadas', tag: 'wallet', feature: 'attest', params: S.deviceIdParam, ok: okObj({ transactions: S.arr(S.any) }, ['transactions']), handler: async ({ ctx, tenant, params }) => ({ transactions: await txHistory(ctx, tenant, params.deviceId) }) },
  { method: 'post', path: '/v1/devices/{deviceId}/commands/ack', summary: 'El dispositivo confirma comandos ejecutados (p. ej. SE_WIPE)', tag: 'devices', feature: 'panic', params: S.deviceIdParam, body: S.obj({ commands: S.arr(S.str()) }, ['commands']),
    ok: okObj({ pendingCommands: S.arr(S.str()) }, ['pendingCommands']),
    handler: async ({ ctx, tenant, params, body }) => { const d = await getDevice(ctx, params.deviceId, tenant); d.pendingCommands = d.pendingCommands.filter((c) => !body.commands.includes(c)); await ctx.store.put('devices', d.id, d); await ctx.appendLog(`dev:${d.id}`, 'commands_ack', { commands: body.commands }); return { pendingCommands: d.pendingCommands }; } },

  // ---- tasas
  { method: 'get', path: '/v1/rates', summary: 'Snapshot de tasas firmado por el servidor (precarga offline)', tag: 'rates', feature: 'rates', ok: S.rateSnapshot, handler: ({ ctx }) => ensureRates(ctx) },
  { method: 'post', path: '/v1/rates', summary: 'Admin: publica un snapshot de tasas (o refresca desde fuentes BCE/referencia)', tag: 'rates', admin: true,
    body: S.obj({ source: S.str(), ratesMicros: { type: 'object', additionalProperties: S.int({ minimum: 1 }) }, refresh: S.bool }),
    ok: S.rateSnapshot,
    handler: async ({ ctx, body }) => {
      if (body.refresh) return refreshRates(ctx, [ecbSource(), staticReferenceSource]);
      for (const k of Object.keys(body.ratesMicros ?? {})) if (!CURRENCIES.includes(k as never)) throw badRequest('invalid_currency', `moneda no soportada: ${k}`);
      return publishRates(ctx, body.ratesMicros ?? {}, body.source ?? 'manual');
    } },

  // ---- tokenización
  { method: 'post', path: '/v1/tokenize', summary: 'Tokeniza una tarjeta: lote de DPAN de un solo uso + LUK envueltas para el dispositivo', tag: 'tokenization', feature: 'tokenize', status: 200,
    body: S.obj({ deviceId: S.hex(32, 32), pan: S.str({ minLength: 12, maxLength: 23 }), expMonth: S.int({ minimum: 1, maximum: 12 }), expYear: S.int({ minimum: 2024, maximum: 2100 }), currency: S.currency, count: S.int({ minimum: 1, maximum: 50 }), ttlHours: S.int({ minimum: 1, maximum: 168 }) }, ['deviceId', 'pan', 'expMonth', 'expYear', 'currency']),
    ok: okObj({ cardRef: S.str(), last4: S.str(), brand: S.str(), tokens: S.arr(okObj({ token: S.str(), expiresAt: S.int() }, ['token', 'expiresAt'])), lukBundle: S.wrapped }, ['cardRef', 'last4', 'tokens', 'lukBundle']),
    handler: ({ ctx, tenant, body }) => tokenize(ctx, tenant, body) },
  { method: 'post', path: '/v1/tokens/revoke', summary: 'Revoca todos los tokens activos de una tarjeta', tag: 'tokenization', feature: 'tokenize',
    body: S.obj({ deviceId: S.hex(32, 32), cardRef: S.str() }, ['deviceId', 'cardRef']), ok: okObj({ revoked: S.int() }, ['revoked']),
    handler: async ({ ctx, tenant, body }) => ({ revoked: await revokeCardTokens(ctx, tenant, body.deviceId, body.cardRef) }) },
  { method: 'post', path: '/v1/wallets/provision', summary: 'Aprovisiona la tarjeta tokenizada a Google Wallet / Apple Wallet (simulado)', tag: 'tokenization', feature: 'tokenize',
    body: S.obj({ deviceId: S.hex(32, 32), wallet: { type: 'string', enum: ['google_pay', 'apple_pay'] }, cardRef: S.str() }, ['deviceId', 'wallet', 'cardRef']),
    ok: okObj({ wallet: S.str(), tokenReferenceId: S.str(), limitations: S.arr(S.str()), signature: S.str() }, ['wallet', 'tokenReferenceId', 'limitations', 'signature']),
    handler: ({ ctx, tenant, body }) => provisionWallet(ctx, tenant, body) },

  // ---- pagos offline
  { method: 'post', path: '/v1/authorize-offline', summary: 'Autoriza y liquida un voucher de pago offline (comercio con red)', tag: 'payments', feature: 'authorize',
    body: S.voucher, ok: okObj({ txId: S.str(), status: { type: 'string', enum: ['settled', 'duplicate', 'declined', 'rejected'] }, reason: S.str(), riskScore: S.int() }, ['txId', 'status']),
    handler: ({ ctx, tenant, body }) => authorizeOffline(ctx, tenant, body) },
  { method: 'post', path: '/v1/reconcile', summary: 'Replay del ledger/WAL offline: cadena hash+MAC+firma, anti doble gasto, ajuste FX', tag: 'payments', feature: 'reconcile',
    body: S.obj({ deviceId: S.hex(32, 32), entries: S.arr(S.ledgerEntry, { maxItems: 500 }) }, ['deviceId', 'entries']),
    ok: okObj({ deviceId: S.str(), accepted: S.int(), lastSeq: S.int(), lastHash: S.str(), chainOk: S.bool, deviceStatus: S.str(), results: S.arr(S.any) }, ['deviceId', 'accepted', 'chainOk', 'results']),
    handler: ({ ctx, tenant, body }) => reconcile(ctx, tenant, body.deviceId, body.entries) },

  // ---- Protocolo Escudo
  { method: 'post', path: '/v1/panic', summary: 'Activa el Protocolo Escudo (botón, PIN de coacción, SMS o web remota)', tag: 'panic', feature: 'panic',
    body: S.obj({ deviceId: S.hex(32, 32), trigger: { type: 'string', enum: ['button', 'duress_pin', 'sms', 'remote_web'] }, pin: S.str(), ts: S.int(), signature: S.b64(), location: S.obj({ lat: { type: 'number' }, lon: { type: 'number' } }, ['lat', 'lon']) }, ['deviceId', 'trigger']),
    ok: okObj({ deviceId: S.str(), status: S.str(), tokensRevoked: S.int(), commands: S.arr(S.str()), notifiedContacts: S.int(), alreadyShielded: S.bool }, ['deviceId', 'status', 'commands']),
    handler: ({ ctx, tenant, body }) => activateShield(ctx, tenant, body) },
  { method: 'post', path: '/v1/devices/{deviceId}/unlock', summary: 'Reactiva un dispositivo bloqueado preventivamente (PIN real)', tag: 'panic', feature: 'panic', params: S.deviceIdParam, body: S.obj({ pin: S.str() }, ['pin']),
    ok: okObj({ deviceId: S.str(), status: S.str() }, ['deviceId', 'status']), handler: ({ ctx, tenant, params, body }) => unlockDevice(ctx, tenant, params.deviceId, body.pin) },
  { method: 'post', path: '/v1/devices/{deviceId}/location', summary: 'Geofencing de riesgo + detección de clonación (misma identidad en IP/geo distintas)', tag: 'panic', feature: 'panic', params: S.deviceIdParam,
    body: S.obj({ lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 }, biometricRecent: S.bool }, ['lat', 'lon', 'biometricRecent']),
    ok: okObj({ deviceId: S.str(), inside: S.bool, action: S.str() }, ['deviceId', 'inside', 'action']), handler: ({ ctx, tenant, params, body, ip }) => checkLocation(ctx, tenant, params.deviceId, { ...body, ip }) },
  { method: 'post', path: '/v1/devices/{deviceId}/checkin', summary: 'Prueba de vida (testamento digital)', tag: 'panic', feature: 'panic', params: S.deviceIdParam, body: sigBody,
    ok: okObj({ deviceId: S.str(), lastProofOfLife: S.int() }, ['deviceId', 'lastProofOfLife']), handler: ({ ctx, tenant, params, body }) => proofOfLife(ctx, tenant, params.deviceId, body) },
  { method: 'get', path: '/v1/risk-flags/{userRef}', summary: 'Estado firmado de riesgo de suplantación (bancos, centrales de riesgo, Meta/X/WhatsApp)', tag: 'panic', feature: 'risk', params: S.obj({ userRef: S.str() }, ['userRef']),
    ok: okObj({ userRef: S.str(), atRisk: S.bool, compromisedAccount: S.bool, serverPublicKey: S.str() }, ['userRef', 'atRisk', 'compromisedAccount']), handler: ({ ctx, params }) => getRiskFlag(ctx, params.userRef) },
  { method: 'post', path: '/v1/webhooks/fraud', summary: 'Entrada: reporte de fraude de un aliado, firmado con HMAC (x-sw-timestamp, x-sw-signature)', tag: 'webhooks', feature: 'webhooks',
    body: S.obj({ deviceId: S.hex(32, 32), source: S.str(), kind: S.str(), details: S.str() }, ['deviceId', 'source', 'kind']),
    ok: okObj({ deviceId: S.str(), status: S.str(), riskFlag: S.any }, ['deviceId', 'status']),
    handler: async ({ ctx, tenant, body, headers, rawBody }) => {
      const ts = String(headers['x-sw-timestamp'] ?? ''); const sig = String(headers['x-sw-signature'] ?? '').replace(/^v1=/, '');
      if (!ts || !sig || Math.abs(ctx.now() - Number(ts)) > 5 * 60_000) throw forbidden('bad_webhook_signature', 'firma o timestamp ausentes/vencidos');
      const exp = hmacHex(Buffer.from(tenant.webhookSecret, 'utf8'), `${ts}.${rawBody ?? canonical(body)}`);
      if (!safeEqualHex(sig, exp)) throw forbidden('bad_webhook_signature', 'firma HMAC inválida');
      return reportFraud(ctx, tenant, body);
    } },
  { method: 'post', path: '/v1/webhooks/subscriptions', summary: 'Suscribe un endpoint a eventos de fraude (salida, firmados con HMAC)', tag: 'webhooks', feature: 'webhooks', status: 201,
    body: S.obj({ url: S.str({ format: 'uri' }), events: S.arr(S.str(), { minItems: 1 }) }, ['url', 'events']),
    ok: okObj({ id: S.str(), secret: S.str(), events: S.arr(S.str()) }, ['id', 'secret', 'events']),
    handler: async ({ ctx, tenant, body }) => { const u = new URL(body.url); if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('bad_url', 'solo http/https'); const sub = { id: 'wh_' + randomHex(6), tenantId: tenant.id, url: body.url, secret: randomHex(24), events: body.events }; await ctx.store.put('webhook_subs', sub.id, sub); return { id: sub.id, secret: sub.secret, events: sub.events }; } },
  { method: 'get', path: '/v1/webhooks/subscriptions', summary: 'Lista suscripciones de webhooks', tag: 'webhooks', feature: 'webhooks', ok: okObj({ subscriptions: S.arr(S.any) }, ['subscriptions']),
    handler: async ({ ctx, tenant }) => ({ subscriptions: (await ctx.store.find<{ id: string; url: string; events: string[] }>('webhook_subs', { tenantId: tenant.id })).map((s) => ({ id: s.id, url: s.url, events: s.events })) }) },

  // ---- QR
  { method: 'post', path: '/v1/qr/dynamic', summary: 'Genera un QR dinámico firmado (monto, moneda, snapshot de tasas, DPAN)', tag: 'qr', feature: 'qr', status: 200,
    body: S.obj({ deviceId: S.hex(32, 32), amountMinor: S.int({ minimum: 1 }), currency: S.currency, ttlSeconds: S.int({ minimum: 30, maximum: 3600 }), includeRates: S.bool }, ['deviceId', 'amountMinor', 'currency']),
    ok: okObj({ qrId: S.str(), expiresAt: S.int(), qr: S.str() }, ['qrId', 'qr']), handler: ({ ctx, tenant, body }) => createDynamicQr(ctx, tenant, body) },
  { method: 'post', path: '/v1/qr/verify', summary: 'Verifica un QR dinámico (firma del servidor, vigencia, tasas)', tag: 'qr', feature: 'qr', body: S.obj({ qr: S.str() }, ['qr']),
    ok: okObj({ valid: S.bool }, ['valid']), handler: async ({ ctx, body }) => { const r = verifyDynamicQr(ctx, body.qr); return { valid: r.valid, reason: r.reason ?? null, payload: r.payload ?? null }; } },
  { method: 'get', path: '/v1/qr/{qrId}', summary: 'Estado de pago de un QR dinámico', tag: 'qr', feature: 'qr', params: S.obj({ qrId: S.str() }, ['qrId']), ok: okObj({ qrId: S.str(), expired: S.bool, paid: S.bool }, ['qrId', 'paid']), handler: ({ ctx, params }) => getQrStatus(ctx, params.qrId) },
  { method: 'post', path: '/v1/qr/emv/parse', summary: 'Interoperabilidad: reconoce y valida un QR EMVCo (Yape/Plin/otros)', tag: 'qr', feature: 'qr', body: S.obj({ payload: S.str({ minLength: 20, maxLength: 1024 }) }, ['payload']),
    ok: okObj({ valid: S.bool, wallet: S.str(), merchantName: S.str(), currency: S.any, amountMinor: S.any, emvHash: S.str() }, ['valid', 'wallet', 'emvHash']), handler: async ({ body }) => parseEmv(body.payload) },
  { method: 'post', path: '/v1/qr/emv/route', summary: 'Enruta un voucher firmado hacia la pasarela de la billetera destino (mock en MVP)', tag: 'qr', feature: 'qr',
    body: S.obj({ emvPayload: S.str({ minLength: 20, maxLength: 1024 }), voucher: S.voucher }, ['emvPayload', 'voucher']),
    ok: okObj({ tx: S.any, gateway: S.any }, ['tx']), handler: ({ ctx, tenant, body }) => routeEmvVoucher(ctx, tenant, body) },

  // ---- SMS
  { method: 'post', path: '/v1/sms/inbound', summary: 'Gateway SMS: procesa SAFE-SOS-<PIN> y pagos cifrados SWPAY1', tag: 'sms', feature: 'sms', body: S.obj({ from: S.str(), to: S.str(), body: S.str({ maxLength: 2000 }) }, ['from', 'to', 'body']),
    ok: okObj({ kind: S.str() }, ['kind']), handler: ({ ctx, tenant, body }) => handleInboundSms(ctx, tenant, body) },
  { method: 'post', path: '/v1/outbox/{deviceId}/dispatch', summary: 'Proveedor SMS/email (mock): entrega y marca como enviados los mensajes en cola', tag: 'sms', feature: 'sms', params: S.deviceIdParam, ok: okObj({ messages: S.arr(S.any) }, ['messages']),
    handler: async ({ ctx, tenant, params }) => {
      await getDevice(ctx, params.deviceId, tenant);
      const msgs = (await ctx.store.find<any>('outbox', { deviceId: params.deviceId, status: 'queued' })).sort((a, b) => a.createdAt - b.createdAt);
      for (const m of msgs) { m.status = 'sent'; await ctx.store.put('outbox', m.id, m); ctx.log.info({ id: m.id, kind: m.kind, to: m.to }, 'mensaje entregado al proveedor (mock)'); }
      return { messages: msgs.map((m) => ({ id: m.id, kind: m.kind, to: m.to, body: m.body, silent: !!m.silent, sig: m.sig })) };
    } },

  // ---- reportes y forense
  { method: 'get', path: '/v1/reports/{deviceId}', summary: 'Informe firmado (hourly|daily|weekly|monthly|yearly) anclado en log append-only', tag: 'reports', feature: 'reports', params: S.deviceIdParam,
    query: S.obj({ period: { type: 'string', enum: Object.keys(PERIODS) } }, ['period']),
    ok: okObj({ deviceId: S.str(), period: S.str(), hash: S.str(), sig: S.str(), txCount: S.int() }, ['deviceId', 'period', 'hash', 'sig']), handler: ({ ctx, tenant, params, query }) => generateReport(ctx, tenant, params.deviceId, query.period) },
  { method: 'post', path: '/v1/forensic/{deviceId}/logs', summary: 'Sube logs/denuncias cifrados con cadena de custodia (hash chain)', tag: 'forensic', feature: 'forensic', params: S.deviceIdParam,
    body: S.obj({ entries: S.arr(S.obj({ index: S.int({ minimum: 0 }), type: S.str(), ts: S.int(), ciphertext: S.b64(), prevHash: S.hex(64, 64), hash: S.hex(64, 64), sig: S.b64() }, ['index', 'type', 'ts', 'ciphertext', 'prevHash', 'hash', 'sig']), { minItems: 1, maxItems: 500 }) }, ['entries']),
    ok: okObj({ deviceId: S.str(), accepted: S.int(), headIndex: S.int(), headHash: S.str() }, ['deviceId', 'accepted', 'headHash']), handler: ({ ctx, tenant, params, body }) => uploadForensic(ctx, tenant, params.deviceId, body.entries) },
  { method: 'get', path: '/v1/forensic/{deviceId}/export', summary: 'Exporta paquete de evidencia verificado (para comisaría/fiscalía)', tag: 'forensic', feature: 'forensic', params: S.deviceIdParam,
    ok: okObj({ deviceId: S.str(), headHash: S.str(), count: S.int(), deviceChainOk: S.bool, anchorsOk: S.bool, bundleSig: S.str() }, ['deviceId', 'deviceChainOk', 'anchorsOk', 'bundleSig']), handler: ({ ctx, tenant, params }) => exportForensic(ctx, tenant, params.deviceId) },
  { method: 'get', path: '/v1/devices/{deviceId}/audit', summary: 'Log de auditoría append-only del dispositivo (verificable)', tag: 'forensic', feature: 'forensic', params: S.deviceIdParam, ok: okObj({ records: S.arr(S.any), serverPublicKey: S.str() }, ['records']),
    handler: async ({ ctx, tenant, params }) => { const d = await getDevice(ctx, params.deviceId, tenant); return { records: (await ctx.store.list<any>(`log:dev:${d.id}`, 100000)).sort((a, b) => a.index - b.index), serverPublicKey: ctx.secrets.server.publicKey }; } },

  // ---- administración
  { method: 'post', path: '/v1/admin/sweep', summary: 'Admin: ejecuta barridos (testamento digital, informes vencidos)', tag: 'admin', admin: true, ok: okObj({ deadman: S.arr(S.str()), reports: S.int() }, ['deadman', 'reports']),
    handler: async ({ ctx }) => ({ deadman: await sweepDeadman(ctx), reports: await sweepReports(ctx) }) },
  { method: 'post', path: '/v1/admin/builds', summary: 'Admin: registra un build legítimo (watermark de build + hash de app esperado)', tag: 'admin', admin: true, status: 201,
    body: S.obj({ buildId: S.str(), appHash: S.str() }, ['buildId', 'appHash']), ok: okObj({ buildId: S.str() }, ['buildId']),
    handler: async ({ ctx, body }) => { await registerBuild(ctx, body.buildId, body.appHash); return { buildId: body.buildId }; } },
];

export { notFound, assertOperable };
