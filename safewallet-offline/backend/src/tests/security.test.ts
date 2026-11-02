import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { H, SimDevice, call, makeEnv, type Env } from './helpers.js';
import { sweepDeadman } from '../services/panic.js';
import { verifyLogChain, type LogRecord } from '../ctx.js';
import { ecdsaVerify, hmacHex, sha256Hex } from '../util/crypto.js';
import { canonical } from '../util/canonical.js';
import { buildEmv, parseEmv } from '../services/qr-interop.js';
import { encodeSmsPayment } from '../services/sms.js';
import { computeArqc } from '../services/tokenization.js';
import { crossRateMicros, payerPriceMinor } from '../services/rates.js';
import { sweepReports } from '../services/reports.js';
import { forensicHash } from '../services/forensic.js';

let env: Env; let alice: SimDevice; let taxi: SimDevice;
const contacts = [{ name: 'Mamá', phone: '+51999111000' }, { name: 'Hermano', phone: '+51999222000' }];
beforeEach(async () => {
  env = await makeEnv();
  alice = await new SimDevice(env).register();
  taxi = await new SimDevice(env).register();
  await alice.profile({ phone: '+51999000111', pin: '1234', duressPin: '4321', email: 'alice@example.com', trustedContacts: contacts, safeZone: { lat: -12.0464, lon: -77.0428, radiusM: 5000 } });
  await taxi.profile({ phone: '+51999000222', pin: '9999' });
  await alice.fund('PEN', 100_000); await alice.tokenize(10); await taxi.tokenize(3);
});
afterEach(async () => { await env.close(); });

const panic = (d: SimDevice, trigger: string, extra: Record<string, unknown> = {}) => call(env, 'POST', '/v1/panic', { deviceId: d.id, trigger, ...extra });

describe('Protocolo Escudo', () => {
  it('botón: revoca tokens, invalida claves/sesiones, ordena wipe, notifica contactos y marca riesgo 72 h', async () => {
    const p = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' }); // voucher pre-robo en poder de la víctima
    const op = alice.signedOp('panic', { trigger: 'button' });
    const r = await panic(alice, 'button', { ...op, location: { lat: -12.05, lon: -77.04 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'shielded', alreadyShielded: false, notifiedContacts: 2, silent: false });
    expect(r.body.tokensRevoked).toBe(10);
    expect(r.body.commands).toEqual(expect.arrayContaining(['SE_WIPE', 'FREEZE_LEDGER', 'INVALIDATE_SESSIONS']));
    // vouchers anteriores quedan congelados
    expect((await call(env, 'POST', '/v1/authorize-offline', p.voucher)).body.reason).toBe('device_shielded');
    const d = (await call(env, 'GET', `/v1/devices/${alice.id}`)).body;
    expect(d).toMatchObject({ status: 'shielded', keyEpoch: 2, sessionEpoch: 2 });
    // mensajes a contactos: firmados, con el texto predefinido
    const out = await call(env, 'POST', `/v1/outbox/${alice.id}/dispatch`);
    const sms = out.body.messages.filter((m: any) => m.kind === 'sms');
    expect(sms.map((m: any) => m.to).sort()).toEqual(contacts.map((c) => c.phone).sort());
    expect(sms[0].body).toContain('no soy yo quien pide dinero');
    expect(sms[0].body).toContain('maps.google.com');
    expect(sms[0].sig.length).toBeGreaterThan(40);
    expect(out.body.messages.some((m: any) => m.kind === 'email' && m.to === 'alice@example.com')).toBe(true);
    // riesgo de suplantación firmado, consultable por bancos / Meta / X / WhatsApp
    const userRef = (await call(env, 'PUT', `/v1/devices/${alice.id}/profile`, {})).body.userRef;
    const flag = await call(env, 'GET', `/v1/risk-flags/${userRef}`);
    expect(flag.body).toMatchObject({ atRisk: true, compromisedAccount: true });
    expect(flag.body.expiresAt - flag.body.issuedAt).toBe(72 * 3600_000);
    expect(ecdsaVerify(flag.body.serverPublicKey, flag.body.hash, flag.body.sig)).toBe(true);
    // expira a las 72 h
    env.clock.t += 73 * 3600_000;
    expect((await call(env, 'GET', `/v1/risk-flags/${userRef}`)).body.atRisk).toBe(false);
  });
  it('es idempotente y rechaza firma inválida o vencida', async () => {
    const bad = await panic(alice, 'button', { ts: env.clock.t, signature: 'A'.repeat(86) });
    expect(bad.status).toBe(403);
    const old = alice.signedOp('panic', { trigger: 'button' }); env.clock.t += 8 * 86_400_000;
    expect((await panic(alice, 'button', old)).status).toBe(403);
    const queued = alice.signedOp('panic', { trigger: 'button' }); // pánico firmado sin red y entregado horas después
    env.clock.t += 6 * 3600_000;
    expect((await panic(alice, 'button', queued)).body.alreadyShielded).toBe(false);
    expect((await panic(alice, 'button', alice.signedOp('panic', { trigger: 'button' }))).body.alreadyShielded).toBe(true);
  });
  it('PIN de coacción: entra en modo señuelo, alerta silenciosa y no distingue de un login normal para el atacante', async () => {
    const r = await panic(alice, 'duress_pin', { ...alice.signedOp('panic', { trigger: 'duress_pin' }), pin: '4321' });
    expect(r.body).toMatchObject({ status: 'shielded', silent: true });
    expect(r.body.commands).toContain('ENTER_DECOY');
    const out = await call(env, 'POST', `/v1/outbox/${alice.id}/dispatch`);
    expect(out.body.messages.filter((m: any) => m.kind === 'sms').every((m: any) => m.silent)).toBe(true);
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.decoy).toBe(true);
  });
  it('PIN de coacción incorrecto no activa nada y cuenta como fallo', async () => {
    const r = await panic(alice, 'duress_pin', { ...alice.signedOp('panic', { trigger: 'duress_pin' }), pin: '1234' });
    expect(r.status).toBe(403);
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.status).toBe('active');
  });
  it('kill-switch por SMS SAFE-SOS-<PIN> desde cualquier teléfono, con anti fuerza bruta', async () => {
    for (let n = 0; n < 5; n++) {
      const r = await call(env, 'POST', '/v1/sms/inbound', { from: '+51900000000', to: '+51999000111', body: 'SAFE-SOS-0000' });
      expect(r.status).toBe(403);
    }
    const locked = await call(env, 'POST', '/v1/sms/inbound', { from: '+51900000000', to: '+51999000111', body: 'SAFE-SOS-1234' });
    expect(locked.status).toBe(429);
    await env.rt.ctx.kv.del(`pinfail:${alice.id}`);
    const ok = await call(env, 'POST', '/v1/sms/inbound', { from: '+51911111111', to: '+51999000111', body: ' safe-sos-1234 ' });
    expect(ok.body.kind).toBe('sos');
    expect(ok.body.result.status).toBe('shielded');
    expect((await call(env, 'POST', '/v1/sms/inbound', { from: '+519', to: '+51888888888', body: 'SAFE-SOS-1234' })).status).toBe(400);
    expect((await call(env, 'POST', '/v1/sms/inbound', { from: '+519', to: '+51999000111', body: 'hola' })).body.kind).toBe('ignored');
  });
  it('activación remota desde otro dispositivo vía API web (PIN)', async () => {
    expect((await panic(alice, 'remote_web', { pin: '0000' })).status).toBe(403);
    expect((await panic(alice, 'remote_web', { pin: '1234' })).body.status).toBe('shielded');
  });
  it('un dispositivo shielded no se reactiva con PIN (requiere re-registro)', async () => {
    await panic(alice, 'remote_web', { pin: '1234' });
    const r = await call(env, 'POST', `/v1/devices/${alice.id}/unlock`, { pin: '1234' });
    expect(r.status).toBe(400);
    expect((await call(env, 'POST', '/v1/tokenize', { deviceId: alice.id, pan: '4111111111111111', expMonth: 12, expYear: 2030, currency: 'PEN' })).status).toBe(403);
  });
  it('el dispositivo confirma comandos pendientes', async () => {
    await panic(alice, 'remote_web', { pin: '1234' });
    const ack = await call(env, 'POST', `/v1/devices/${alice.id}/commands/ack`, { commands: ['SE_WIPE'] });
    expect(ack.body.pendingCommands).not.toContain('SE_WIPE');
  });
  it('notifica por webhook firmado: shield, identidad comprometida y bloqueo de préstamos', async () => {
    const got: { event: string; sig: string; ts: string; body: string }[] = [];
    const srv: Server = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ event: String(req.headers['x-sw-event']), sig: String(req.headers['x-sw-signature']), ts: String(req.headers['x-sw-timestamp']), body: b }); res.end('ok'); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const sub = await call(env, 'POST', '/v1/webhooks/subscriptions', { url: `http://127.0.0.1:${port}/hook`, events: ['*'] });
    expect(sub.status).toBe(201);
    await panic(alice, 'remote_web', { pin: '1234' });
    await env.rt.ctx.flush();
    srv.close();
    expect(got.map((g) => g.event)).toEqual(expect.arrayContaining(['fraud.shield_activated', 'loan.block_requested']));
    const g = got[0];
    expect(g.sig).toBe('v1=' + hmacHex(Buffer.from(sub.body.secret, 'utf8'), `${g.ts}.${g.body}`));
  });
  it('webhook de salida bloquea destinos privados cuando webhookAllowPrivate=false (SSRF)', async () => {
    env.rt.ctx.cfg.webhookAllowPrivate = false;
    await call(env, 'POST', '/v1/webhooks/subscriptions', { url: 'http://127.0.0.1:9/x', events: ['*'] });
    await panic(alice, 'remote_web', { pin: '1234' });
    await env.rt.ctx.flush();
    const dl = await env.rt.ctx.store.list<any>('webhook_deliveries');
    expect(dl.length).toBeGreaterThan(0);
    expect(dl.every((x) => /SSRF/.test(x.error))).toBe(true);
  });
  it('webhook de entrada: reporte de fraude de un banco aliado firmado con HMAC', async () => {
    const { createTenant } = await import('../services/tenants.js');
    const body = JSON.stringify({ deviceId: alice.id, source: 'banco-x', kind: 'loan_attempt' });
    const tenant = (await env.rt.ctx.store.list<any>('tenants')).find((t) => t.name === 'Sandbox público');
    const ts = String(env.clock.t);
    const good = hmacHex(Buffer.from(tenant.webhookSecret, 'utf8'), `${ts}.${body}`);
    const bad = await env.app.inject({ method: 'POST', url: '/v1/webhooks/fraud', headers: { ...H, 'x-sw-timestamp': ts, 'x-sw-signature': 'v1=' + 'f'.repeat(64) }, payload: body });
    expect(bad.statusCode).toBe(403);
    const ok = await env.app.inject({ method: 'POST', url: '/v1/webhooks/fraud', headers: { ...H, 'x-sw-timestamp': ts, 'x-sw-signature': 'v1=' + good }, payload: body });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).status).toBe('locked');
    const stale = await env.app.inject({ method: 'POST', url: '/v1/webhooks/fraud', headers: { ...H, 'x-sw-timestamp': String(env.clock.t - 3600_000), 'x-sw-signature': 'v1=' + good }, payload: body });
    expect(stale.statusCode).toBe(403);
    void createTenant;
  });
});

describe('geofencing, clonación y testamento digital', () => {
  it('fuera de la zona segura sin biometría reciente → bloqueo preventivo', async () => {
    expect((await call(env, 'POST', `/v1/devices/${alice.id}/location`, { lat: -12.05, lon: -77.04, biometricRecent: false })).body).toMatchObject({ inside: true, action: 'none' });
    const out = await call(env, 'POST', `/v1/devices/${alice.id}/location`, { lat: -12.5, lon: -76.5, biometricRecent: true });
    expect(out.body).toMatchObject({ inside: false, action: 'none' });
    const bad = await call(env, 'POST', `/v1/devices/${alice.id}/location`, { lat: -12.5, lon: -76.5, biometricRecent: false });
    expect(bad.body).toMatchObject({ inside: false, action: 'locked' });
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.status).toBe('locked');
  });
  it('clonación: mismo device-id en dos IPs/geos incompatibles → bloqueo automático', async () => {
    const hit = (ip: string, lat: number, lon: number) => env.app.inject({ method: 'POST', url: `/v1/devices/${alice.id}/location`, headers: H, remoteAddress: ip, payload: JSON.stringify({ lat, lon, biometricRecent: true }) });
    expect(JSON.parse((await hit('10.0.0.1', -12.04, -77.04)).body).action).toBe('none');
    expect(JSON.parse((await hit('10.0.0.1', -12.04, -77.04)).body).action).toBe('none');
    expect(JSON.parse((await hit('8.8.8.8', 40.4, -3.7)).body).action).toBe('clone_blocked'); // Madrid, 3 minutos después
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.status).toBe('blocked');
  });
  it('testamento digital: sin prueba de vida activa el Escudo; con check-in no', async () => {
    await alice.profile({ deadmanHours: 24 });
    env.clock.t += 20 * 3600_000;
    expect(await sweepDeadman(env.rt.ctx)).toEqual([]);
    expect((await call(env, 'POST', `/v1/devices/${alice.id}/checkin`, alice.signedOp('checkin'))).status).toBe(200);
    env.clock.t += 20 * 3600_000;
    expect(await sweepDeadman(env.rt.ctx)).toEqual([]);
    env.clock.t += 5 * 3600_000;
    expect(await sweepDeadman(env.rt.ctx)).toEqual([alice.id]);
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.status).toBe('shielded');
    const out = await call(env, 'POST', `/v1/outbox/${alice.id}/dispatch`);
    expect(out.body.messages.find((m: any) => m.kind === 'sms').body).toContain('no pude confirmar');
    const viaAdmin = await call(env, 'POST', '/v1/admin/sweep', {}, { 'x-api-key': 'sw_admin_test_key', 'content-type': 'application/json' });
    expect(viaAdmin.status).toBe(200);
  });
});

describe('auditoría forense y cadena de custodia', () => {
  it('ancla logs cifrados, rechaza forks/rupturas y exporta paquete verificable', async () => {
    const e = [alice.forensicEntry('robbery_report', 'me asaltaron en Av. Arequipa'), alice.forensicEntry('screenshot', 'hash:abc'), alice.forensicEntry('location', '-12.04,-77.04')];
    const up = await call(env, 'POST', `/v1/forensic/${alice.id}/logs`, { entries: e });
    expect(up.body).toMatchObject({ accepted: 3, headIndex: 2 });
    expect((await call(env, 'POST', `/v1/forensic/${alice.id}/logs`, { entries: e })).body.accepted).toBe(0); // reenvío idempotente
    const bb = { index: 3, type: 'x', ts: env.clock.t, ciphertext: Buffer.from('y').toString('base64url'), prevHash: '0'.repeat(64) };
    const bh = forensicHash(alice.id, bb);
    const broken = { ...bb, hash: bh, sig: alice.sign(bh) };
    expect((await call(env, 'POST', `/v1/forensic/${alice.id}/logs`, { entries: [broken] })).body.error.code).toBe('forensic_chain_broken');
    const exp = await call(env, 'GET', `/v1/forensic/${alice.id}/export`);
    expect(exp.body).toMatchObject({ deviceChainOk: true, anchorsOk: true, count: 3 });
    expect(ecdsaVerify(exp.body.serverPublicKey, sha256Hex(canonical({ deviceId: alice.id, devicePublicKey: alice.kp.publicKey, exportedAt: exp.body.exportedAt, headHash: exp.body.headHash, count: 3 })), exp.body.bundleSig)).toBe(true);
    // un fork (misma posición, otro contenido) se rechaza
    const forkBase = { index: 1, type: 'screenshot', ts: e[1].ts, ciphertext: Buffer.from('otro').toString('base64url'), prevHash: e[0].hash };
    const forkHash = forensicHash(alice.id, forkBase);
    const fork = { ...forkBase, hash: forkHash, sig: alice.sign(forkHash) };
    expect((await call(env, 'POST', `/v1/forensic/${alice.id}/logs`, { entries: [fork] })).status).toBe(409);
    const stale = { ...e[1], ciphertext: Buffer.from('otro').toString('base64url') };
    expect((await call(env, 'POST', `/v1/forensic/${alice.id}/logs`, { entries: [stale] })).body.error.code).toBe('forensic_hash_invalid');
  });
  it('el log de auditoría del dispositivo es una cadena firmada verificable', async () => {
    await panic(alice, 'remote_web', { pin: '1234' });
    const a = await call(env, 'GET', `/v1/devices/${alice.id}/audit`);
    expect(a.body.records.length).toBeGreaterThan(3);
    expect(verifyLogChain(a.body.records as LogRecord[], a.body.serverPublicKey)).toBe(-1);
    const tampered = JSON.parse(JSON.stringify(a.body.records)); tampered[1].data.status = 'x';
    expect(verifyLogChain(tampered, a.body.serverPublicKey)).toBe(1);
  });
});

describe('reportes firmados', () => {
  it('genera informes por periodo, firmados y en log append-only; sweep periódico', async () => {
    await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' }).voucher);
    for (const period of ['hourly', 'daily', 'weekly', 'monthly', 'yearly']) {
      const r = await call(env, 'GET', `/v1/reports/${alice.id}?period=${period}`);
      expect(r.status).toBe(200);
      expect(r.body.txCount).toBe(1);
      expect(r.body.outgoingMinor.PEN).toBe(1000);
      const { hash, sig, logIndex, logHash, ...body } = r.body;
      expect(sha256Hex(canonical(body))).toBe(hash);
      expect(ecdsaVerify(alice.serverPub, hash, sig)).toBe(true);
      expect(typeof logIndex).toBe('number'); expect(typeof logHash).toBe('string');
    }
    expect((await call(env, 'GET', `/v1/reports/${alice.id}?period=century`)).status).toBe(400);
    const inc = await call(env, 'GET', `/v1/reports/${taxi.id}?period=daily`);
    expect(inc.body.incomingMinor.PEN).toBe(1000);
    const chain = await env.rt.ctx.store.list<LogRecord>(`log:reports:${alice.id}`);
    expect(verifyLogChain(chain.sort((a, b) => a.index - b.index), alice.serverPub)).toBe(-1);
    expect(await sweepReports(env.rt.ctx)).toBe(5);   // alice tiene email → 5 periodos
    expect(await sweepReports(env.rt.ctx)).toBe(0);   // aún no vencen
    env.clock.t += 2 * 3600_000;
    expect(await sweepReports(env.rt.ctx)).toBe(1);   // vence el horario
  });
});

describe('QR dinámico firmado', () => {
  it('el taxista genera QR; el cliente verifica offline con la clave del servidor, paga por QR y el QR es de un solo uso', async () => {
    const q = await call(env, 'POST', '/v1/qr/dynamic', { deviceId: taxi.id, amountMinor: 1200, currency: 'USD' });
    expect(q.body.qr.startsWith('SWQR1:')).toBe(true);
    const parsed = JSON.parse(Buffer.from(q.body.qr.slice(6), 'base64url').toString());
    expect(ecdsaVerify(alice.serverPub, canonical((({ rates, ...r }) => r)(parsed.p)), parsed.s)).toBe(true);
    expect(parsed.p.payeeDpan).toMatch(/^\d{16}$/);
    expect((await call(env, 'POST', '/v1/qr/verify', { qr: q.body.qr })).body.valid).toBe(true);
    const tampered = 'SWQR1:' + Buffer.from(JSON.stringify({ p: { ...parsed.p, amountMinor: 1 }, s: parsed.s })).toString('base64url');
    expect((await call(env, 'POST', '/v1/qr/verify', { qr: tampered })).body).toMatchObject({ valid: false, reason: 'bad_signature' });
    const pay = alice.pay({ payee: taxi, amountMinor: 1200, currency: 'USD', channel: 'qr', nonce: q.body.qrId, snapshot: parsed.p.rates });
    const ok = await call(env, 'POST', '/v1/authorize-offline', pay.voucher);
    expect(ok.body.status).toBe('settled');
    expect((await call(env, 'GET', `/v1/qr/${q.body.qrId}`)).body).toMatchObject({ paid: true, expired: false });
    const replay = alice.pay({ payee: taxi, amountMinor: 1200, currency: 'USD', channel: 'qr', nonce: q.body.qrId });
    expect((await call(env, 'POST', '/v1/authorize-offline', replay.voucher)).body.reason).toBe('qr_already_used');
    const wrong = await call(env, 'POST', '/v1/qr/dynamic', { deviceId: taxi.id, amountMinor: 500, currency: 'PEN' });
    const mismatch = alice.pay({ payee: taxi, amountMinor: 100, currency: 'PEN', channel: 'qr', nonce: wrong.body.qrId });
    expect((await call(env, 'POST', '/v1/authorize-offline', mismatch.voucher)).body.reason).toBe('qr_mismatch');
    env.clock.t += 2 * 3600_000;
    expect((await call(env, 'POST', '/v1/qr/verify', { qr: wrong.body.qr })).body).toMatchObject({ valid: false, reason: 'expired' });
    expect((await call(env, 'GET', '/v1/qr/nope')).status).toBe(404);
  });
});

describe('interoperabilidad EMVCo (Yape/Plin) con pasarela simulada', () => {
  const emv = (name = 'TAXI LIMA', amount?: string) => buildEmv({ dynamic: !!amount, guid: 'pe.com.yape', account: '999888777', currencyNumeric: '604', amount, country: 'PE', name, city: 'LIMA' });
  const emvVoucher = (payload: string, amountMinor: number) => {
    const info = parseEmv(payload);
    return alice.pay({ payeeRef: `emv:${info.wallet}:${info.accountId}`, amountMinor, currency: 'PEN', channel: 'qr_emv', tamper: (i) => { i['emvHash'] = info.emvHash; } });
  };
  it('parse + voucher diferido: el taxista (con red) lo sube y se enruta a la pasarela', async () => {
    const payload = emv('TAXI LIMA', '15.00');
    const parsed = await call(env, 'POST', '/v1/qr/emv/parse', { payload });
    expect(parsed.body).toMatchObject({ wallet: 'yape', currency: 'PEN', amountMinor: 1500 });
    const p = emvVoucher(payload, 1500);
    const r = await call(env, 'POST', '/v1/qr/emv/route', { emvPayload: payload, voucher: p.voucher });
    expect(r.body.tx.status).toBe('settled');
    expect(r.body.gateway).toMatchObject({ status: 'ACCEPTED', wallet: 'yape', refunded: false });
    expect((await call(env, 'GET', `/v1/devices/${alice.id}/wallet`)).body.balances.PEN).toBe(100_000 - 1500);
    const again = await call(env, 'POST', '/v1/qr/emv/route', { emvPayload: payload, voucher: p.voucher });
    expect(again.body.tx.status).toBe('duplicate');
  });
  it('si la pasarela rechaza, se reembolsa al pagador', async () => {
    const payload = emv('COMERCIO REJECT');
    const p = emvVoucher(payload, 2500);
    const r = await call(env, 'POST', '/v1/qr/emv/route', { emvPayload: payload, voucher: p.voucher });
    expect(r.body.gateway).toMatchObject({ status: 'REJECTED', refunded: true });
    expect(r.body.tx.status).toBe('declined');
    expect((await call(env, 'GET', `/v1/devices/${alice.id}/wallet`)).body.balances.PEN).toBe(100_000);
  });
  it('rechaza QR adulterado, monto distinto o voucher que no corresponde al QR', async () => {
    const payload = emv('TAXI LIMA', '15.00');
    expect((await call(env, 'POST', '/v1/qr/emv/parse', { payload: payload.replace('15.00', '1.00') })).status).toBe(400);
    const p = emvVoucher(payload, 1400);
    expect((await call(env, 'POST', '/v1/qr/emv/route', { emvPayload: payload, voucher: p.voucher })).body.error.code).toBe('emv_amount_mismatch');
    const other = emv('OTRO', '15.00');
    const q = emvVoucher(payload, 1500);
    expect((await call(env, 'POST', '/v1/qr/emv/route', { emvPayload: other, voucher: q.voucher })).body.error.code).toBe('emv_hash_mismatch');
  });
});

describe('pago por SMS cifrado (solo línea celular)', () => {
  const smsPay = (amount: number, over: Record<string, unknown> = {}) => {
    const token = alice.tokens.shift()!; const counter = alice.counter + 1; alice.counter = counter;
    const txId = 'cc'.repeat(6);
    const p = { t: txId, to: '+51999000222', a: amount, c: 'PEN' as const, pc: 'PEN' as const, s: alice.rates.id, m: 0, k: token, q: computeArqc(alice.lukByToken.get(token)!, { token, amountMinor: amount, currency: 'PEN', counter, txId }), n: counter, ts: env.clock.t, e: alice.epoch, ...over };
    return encodeSmsPayment(alice.smsKey, alice.id, alice.epoch, p as never);
  };
  it('liquida pago SWPAY1 autenticado con AES-GCM y es idempotente', async () => {
    const body = smsPay(1800);
    const r = await call(env, 'POST', '/v1/sms/inbound', { from: '+51999000111', to: '+5100000000', body });
    expect(r.body.kind).toBe('payment');
    expect(r.body.result.status).toBe('settled');
    expect((await call(env, 'GET', `/v1/devices/${taxi.id}/wallet`)).body.balances.PEN).toBe(1800);
    expect((await call(env, 'POST', '/v1/sms/inbound', { from: 'x', to: 'y', body })).body.result.status).toBe('duplicate');
  });
  it('rechaza SMS manipulado, de clave ajena o a número no registrado', async () => {
    const body = smsPay(1800);
    const flipped = body.slice(0, -3) + (body.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await call(env, 'POST', '/v1/sms/inbound', { from: 'x', to: 'y', body: flipped })).body.error.code).toBe('sms_auth_failed');
    const forgedKey = encodeSmsPayment(Buffer.alloc(32, 9), alice.id, alice.epoch, { t: 'dd'.repeat(6), to: '+51999000222', a: 1, c: 'PEN', pc: 'PEN', s: alice.rates.id, m: 0, k: '5'.repeat(16), q: 'a'.repeat(32), n: 99, ts: env.clock.t, e: alice.epoch });
    expect((await call(env, 'POST', '/v1/sms/inbound', { from: 'x', to: 'y', body: forgedKey })).body.error.code).toBe('sms_auth_failed');
    const nobody = smsPay(100, { to: '+51000000000', t: 'ee'.repeat(6) });
    expect((await call(env, 'POST', '/v1/sms/inbound', { from: 'x', to: 'y', body: nobody })).body.error.code).toBe('sms_unknown_payee');
  });
});

describe('contrato OpenAPI 3.1', () => {
  it('documenta todas las rutas registradas y las respuestas cumplen su esquema', async () => {
    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ strict: false, allErrors: true });
    const spec = (await call(env, 'GET', '/openapi.json', undefined, {})).body;
    expect(spec.openapi).toBe('3.1.0');
    const { ROUTES } = await import('../api/routes.js');
    for (const r of ROUTES) expect(spec.paths[r.path]?.[r.method], `${r.method} ${r.path}`).toBeDefined();
    const required = ['/v1/tokenize', '/v1/authorize-offline', '/v1/reconcile', '/v1/panic', '/v1/attest', '/v1/webhooks/fraud'];
    for (const p of required) expect(spec.paths[p], p).toBeDefined();
    const check = (path: string, method: string, status: number, body: unknown) => {
      const schema = spec.paths[path][method].responses[String(status)].content['application/json'].schema;
      const ok = ajv.validate(schema, body);
      expect(ok, `${method} ${path}: ${JSON.stringify(ajv.errors)}`).toBe(true);
    };
    const t = await alice.tokenize(1, '5500005555555559');
    check('/v1/tokenize', 'post', 200, t);
    check('/v1/rates', 'get', 200, (await call(env, 'GET', '/v1/rates')).body);
    check('/v1/plans', 'get', 200, (await call(env, 'GET', '/v1/plans', undefined, {})).body);
    check('/health', 'get', 200, (await call(env, 'GET', '/health', undefined, {})).body);
    const pay = alice.pay({ payee: taxi, amountMinor: 700, currency: 'PEN' });
    check('/v1/authorize-offline', 'post', 200, (await call(env, 'POST', '/v1/authorize-offline', pay.voucher)).body);
    const rec = await alice.reconcile();
    check('/v1/reconcile', 'post', 200, rec.body);
    check('/v1/devices/{deviceId}/wallet', 'get', 200, (await call(env, 'GET', `/v1/devices/${alice.id}/wallet`)).body);
    check('/v1/reports/{deviceId}', 'get', 200, (await call(env, 'GET', `/v1/reports/${alice.id}?period=daily`)).body);
    check('/v1/panic', 'post', 200, (await panic(alice, 'remote_web', { pin: '1234' })).body);
    const err = await call(env, 'POST', '/v1/panic', { nope: 1 });
    check('/v1/panic', 'post', 400, err.body);
    // el cuerpo de petición documentado valida los vouchers reales que usamos
    ajv.validate(spec.paths['/v1/authorize-offline'].post.requestBody.content['application/json'].schema, pay.voucher);
    expect(ajv.errors).toBeNull();
  });
  it('curva de rutas de lista de vendors: sandbox seed de tasas y refresh con fallback', async () => {
    const adm = { 'x-api-key': 'sw_admin_test_key', 'content-type': 'application/json' };
    const r = await call(env, 'POST', '/v1/rates', { ratesMicros: { PEN: 3_800_000 }, source: 'manual' }, adm);
    expect(r.body.ratesMicros.PEN).toBe(3_800_000);
    expect(ecdsaVerify(alice.serverPub, canonical({ id: r.body.id, base: r.body.base, asOf: r.body.asOf, expiresAt: r.body.expiresAt, ratesMicros: r.body.ratesMicros, marginBps: r.body.marginBps, source: r.body.source }), r.body.sig)).toBe(true);
    const refreshed = await call(env, 'POST', '/v1/rates', { refresh: true }, adm); // ECB inaccesible/sandbox → cae a referencia
    expect(refreshed.status).toBe(200);
    expect((await call(env, 'POST', '/v1/rates', { ratesMicros: { XXX: 1 } }, adm)).status).toBe(400);
    expect((await call(env, 'POST', '/v1/rates', {}, H)).status).toBe(403);
    void crossRateMicros; void payerPriceMinor;
  });
});

describe('docs/openapi.json', () => {
  it('está sincronizado con las rutas reales (ejecuta `npm run openapi` si falla)', async () => {
    const { readFileSync } = await import('node:fs');
    const { buildOpenApi } = await import('../api/openapi.js');
    const file = JSON.parse(readFileSync(new URL('../../../docs/openapi.json', import.meta.url), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
});

describe('tasas: robustez ante rotación de clave y vencimiento', () => {
  it('ensureRates republica si el snapshot venció o su firma no verifica', async () => {
    const { ensureRates, latestRates } = await import('../services/rates.js');
    const first = await ensureRates(env.rt.ctx);
    env.clock.t += 25 * 3600_000;
    const second = await ensureRates(env.rt.ctx);
    expect(second.id).not.toBe(first.id);
    const cur = (await latestRates(env.rt.ctx))!;
    await env.rt.ctx.store.put('rates', cur.id, { ...cur, sig: 'A'.repeat(86) });
    const third = await ensureRates(env.rt.ctx);
    const { verifySnapshot } = await import('../services/rates.js');
    expect(verifySnapshot(third, env.rt.ctx.secrets.server.publicKey)).toBe(true);
    expect(third.sig).not.toBe('A'.repeat(86));
  });
});
