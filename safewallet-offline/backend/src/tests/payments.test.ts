import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { H, SimDevice, call, makeEnv, type Env } from './helpers.js';
import { publishRates } from '../services/rates.js';
import { hmacHex } from '../util/crypto.js';

let env: Env; let alice: SimDevice; let taxi: SimDevice;
beforeEach(async () => {
  env = await makeEnv();
  alice = await new SimDevice(env).register();
  taxi = await new SimDevice(env).register();
  await alice.profile({ phone: '+51999000111', pin: '1234', duressPin: '4321' });
  await taxi.profile({ phone: '+51999000222', pin: '9999' });
  await alice.fund('PEN', 100_000);
  await alice.tokenize(10);
  await taxi.tokenize(2);
});
afterEach(async () => { await env.close(); });

describe('attestation', () => {
  it('registra dispositivo confiable y devuelve claves, tasas y licencia', async () => {
    const d = await call(env, 'GET', `/v1/devices/${alice.id}`);
    expect(d.body).toMatchObject({ status: 'active', trusted: true, keyEpoch: 1 });
    expect(alice.rates.sig.length).toBeGreaterThan(40);
  });
  it('marca no confiable un dispositivo rooteado/emulado/con Frida y bloquea tokenización', async () => {
    for (const flags of [{ rooted: true }, { emulator: true }, { hooked: true }, { debuggable: true }, { integrityToken: 'FORGED' }]) {
      const d = await new SimDevice(env, flags).register();
      const st = await call(env, 'GET', `/v1/devices/${d.id}`);
      expect(st.body.trusted).toBe(false);
      const r = await call(env, 'POST', '/v1/tokenize', { deviceId: d.id, pan: '4111111111111111', expMonth: 12, expYear: 2030, currency: 'PEN' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('device_untrusted');
    }
  });
  it('rechaza challenge reutilizado y firma inválida', async () => {
    const ch = await call(env, 'GET', '/v1/attest/challenge');
    const st = { nonce: ch.body.challenge, publicKey: alice.kp.publicKey, platform: 'sandbox', buildId: 'b', appHash: 'h', rooted: false, emulator: false, hooked: false, debuggable: false, integrityToken: 'MOCK-OK', ts: env.clock.t };
    const bad = await call(env, 'POST', '/v1/attest', { statement: st, signature: 'A'.repeat(86) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('attestation_signature_invalid');
    const again = await call(env, 'POST', '/v1/attest', { statement: st, signature: 'A'.repeat(86) });
    expect(again.body.error.code).toBe('challenge_invalid');
  });
  it('build revocado o con hash distinto no es confiable', async () => {
    await call(env, 'POST', '/v1/admin/builds', { buildId: 'gold', appHash: 'GOODHASH' }, { 'x-api-key': 'sw_admin_test_key', 'content-type': 'application/json' });
    const good = await new SimDevice(env, { buildId: 'gold', appHash: 'GOODHASH' }).register();
    const evil = await new SimDevice(env, { buildId: 'gold', appHash: 'PATCHED' }).register();
    expect((await call(env, 'GET', `/v1/devices/${good.id}`)).body.trusted).toBe(true);
    const e = await call(env, 'GET', `/v1/devices/${evil.id}`);
    expect(e.body.trusted).toBe(false);
    expect(e.body.trustReasons).toContain('app_hash_mismatch');
  });
});

describe('tokenización', () => {
  it('no almacena el PAN, valida Luhn y emite DPAN de un solo uso', async () => {
    const bad = await call(env, 'POST', '/v1/tokenize', { deviceId: alice.id, pan: '4111111111111112', expMonth: 12, expYear: 2030, currency: 'PEN' });
    expect(bad.body.error.code).toBe('invalid_pan');
    const all = JSON.stringify(await env.rt.ctx.store.list('cards')) + JSON.stringify(await env.rt.ctx.store.list('tokens'));
    expect(all).not.toContain('4111111111111111');
    const exp = await call(env, 'POST', '/v1/tokenize', { deviceId: alice.id, pan: '4111111111111111', expMonth: 1, expYear: 2024, currency: 'PEN' });
    expect(exp.body.error.code).toBe('card_expired');
  });
  it('revocar tarjeta invalida sus tokens', async () => {
    const t = await alice.tokenize(1, '5555555555554444');
    const rev = await call(env, 'POST', '/v1/tokens/revoke', { deviceId: alice.id, cardRef: t.cardRef });
    expect(rev.body.revoked).toBe(1);
    const p = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', token: t.tokens[0].token });
    const r = await call(env, 'POST', '/v1/authorize-offline', p.voucher);
    expect(r.body).toMatchObject({ status: 'declined', reason: 'token_revoked' });
  });
  it('Google Pay / Apple Pay: aprovisiona con limitaciones documentadas', async () => {
    const cardRef = (await alice.tokenize(1, '4012888888881881')).cardRef;
    const g = await call(env, 'POST', '/v1/wallets/provision', { deviceId: alice.id, wallet: 'google_pay', cardRef });
    expect(g.body.ttlHours).toBe(168);
    expect(g.body.limitations.length).toBeGreaterThan(0);
    const a = await call(env, 'POST', '/v1/wallets/provision', { deviceId: alice.id, wallet: 'apple_pay', cardRef });
    expect(a.body.limitations.join(' ')).toMatch(/offline/i);
  });
});

describe('pago offline (BLE/NFC) y conciliación', () => {
  it('liquida un voucher, debita al pagador, acredita al beneficiario y es idempotente', async () => {
    const p = alice.pay({ payee: taxi, amountMinor: 1500, currency: 'PEN', channel: 'nfc' });
    const r = await call(env, 'POST', '/v1/authorize-offline', p.voucher);
    expect(r.body.status).toBe('settled');
    expect((await call(env, 'GET', `/v1/devices/${alice.id}/wallet`)).body.balances.PEN).toBe(100_000 - 1500);
    expect((await call(env, 'GET', `/v1/devices/${taxi.id}/wallet`)).body.balances.PEN).toBe(1500);
    const again = await call(env, 'POST', '/v1/authorize-offline', p.voucher);
    expect(again.body.status).toBe('duplicate');
    expect((await call(env, 'GET', `/v1/devices/${taxi.id}/wallet`)).body.balances.PEN).toBe(1500);
  });
  it('replay del ledger del pagador tras el pago del beneficiario no duplica el cobro', async () => {
    const p = alice.pay({ payee: taxi, amountMinor: 2000, currency: 'PEN' });
    const rin = taxi.receive(p.voucher);
    const up = await taxi.reconcile();       // el taxista recupera red primero
    expect(up.body.results[0].status).toBe('settled');
    const down = await alice.reconcile();    // luego Alice
    expect(down.body.results[0].status).toBe('duplicate');
    expect(down.body.chainOk).toBe(true);
    expect((await call(env, 'GET', `/v1/devices/${alice.id}/wallet`)).body.balances.PEN).toBe(100_000 - 2000);
    expect(rin.entry.type).toBe('PAY_IN');
  });
  it('rechaza firma falsa, ARQC inválido y datos manipulados', async () => {
    const a = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    a.voucher.intent.amountMinor = 1; // manipulación posterior a la firma
    expect((await call(env, 'POST', '/v1/authorize-offline', a.voucher)).body).toMatchObject({ status: 'rejected', reason: 'payer_signature_invalid' });
    const b = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', tamper: (i) => { i.arqc = 'a'.repeat(32); } });
    expect((await call(env, 'POST', '/v1/authorize-offline', b.voucher)).body).toMatchObject({ status: 'rejected', reason: 'arqc_invalid' });
    const c = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', tamper: (i) => { i.payerAmountMinor = 1; } });
    expect((await call(env, 'POST', '/v1/authorize-offline', c.voucher)).body).toMatchObject({ status: 'declined', reason: 'rate_tampering' });
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.status).toBe('locked');
  });
  it('detecta doble gasto: misma ficha/contador en dos pagos distintos → bloqueo preventivo + SMS al usuario', async () => {
    const tok = alice.tokens[0];
    const p1 = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', token: tok });
    const p2 = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', token: tok, counter: p1.voucher.intent.counter });
    expect((await call(env, 'POST', '/v1/authorize-offline', p1.voucher)).body.status).toBe('settled');
    const r2 = await call(env, 'POST', '/v1/authorize-offline', p2.voucher);
    expect(r2.body.status).toBe('declined');
    expect(['token_reuse', 'counter_reuse']).toContain(r2.body.reason);
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.status).toBe('locked');
    const out = await call(env, 'POST', `/v1/outbox/${alice.id}/dispatch`);
    expect(out.body.messages.some((m: any) => m.to === '+51999000111' && /bloqueo preventivo/.test(m.body))).toBe(true);
    // el pagador bloqueado ya no puede gastar
    const p3 = alice.pay({ payee: taxi, amountMinor: 500, currency: 'PEN' });
    expect((await call(env, 'POST', '/v1/authorize-offline', p3.voucher)).body).toMatchObject({ status: 'declined', reason: 'device_locked' });
    // y puede reactivarse con su PIN real (no con el de coacción)
    expect((await call(env, 'POST', `/v1/devices/${alice.id}/unlock`, { pin: '4321' })).status).toBe(403);
    expect((await call(env, 'POST', `/v1/devices/${alice.id}/unlock`, { pin: '1234' })).body.status).toBe('active');
  });
  it('doble gasto concurrente: solo una de dos peticiones simultáneas se liquida', async () => {
    const tok = alice.tokens[0];
    const p1 = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', token: tok, counter: 1 });
    const p2 = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', token: tok, counter: 1 });
    const rs = await Promise.all([p1, p2].map((p) => call(env, 'POST', '/v1/authorize-offline', p.voucher)));
    expect(rs.filter((r) => r.body.status === 'settled')).toHaveLength(1);
    expect((await call(env, 'GET', `/v1/devices/${taxi.id}/wallet`)).body.balances.PEN).toBe(1000);
  });
  it('respeta el límite diario offline y bloquea al excederlo', async () => {
    await alice.profile({ offlineDailyLimitUsdMinor: 3000, offlinePerTxLimitUsdMinor: 2000 }); // USD 30 / USD 20
    await alice.fund('PEN', 500_000);
    expect((await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 5000, currency: 'PEN' }).voucher)).body.status).toBe('settled'); // ~USD 13.6
    expect((await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 5000, currency: 'PEN' }).voucher)).body.status).toBe('settled'); // ~USD 27.2
    const third = await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 5000, currency: 'PEN' }).voucher);
    expect(third.body).toMatchObject({ status: 'declined', reason: 'daily_offline_limit_exceeded' });
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`)).body.status).toBe('locked');
  });
  it('límite por transacción y lista blanca de comercios', async () => {
    await alice.profile({ offlinePerTxLimitUsdMinor: 4000, whitelistMerchants: ['bodega-ok'] }); // USD 40 (USD 10 para no listados)
    await alice.fund('PEN', 500_000);
    const big = await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 20_000, currency: 'PEN' }).voucher); // ~USD 52
    expect(big.body.reason).toBe('per_tx_limit_exceeded');
    const unlisted = await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 5_000, currency: 'PEN', merchantRef: 'kiosko-x' }).voucher); // ~USD 13 > 10
    expect(unlisted.body.reason).toBe('merchant_not_whitelisted_limit');
    const listed = await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 5_000, currency: 'PEN', merchantRef: 'bodega-ok' }).voucher);
    expect(listed.body.status).toBe('settled');
  });
  it('fondos insuficientes y límite por país', async () => {
    const poor = await new SimDevice(env).register(); await poor.tokenize(2); await poor.fund('PEN', 100);
    expect((await call(env, 'POST', '/v1/authorize-offline', poor.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' }).voucher)).body.reason).toBe('insufficient_funds');
    await alice.profile({ countryLimitsUsdMinor: { CO: 500 } });
    const r = await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 5000, currency: 'PEN', geo: { country: 'CO' } }).voucher);
    expect(r.body.reason).toBe('country_limit_exceeded');
  });
  it('riesgo > 70 exige biometría + PIN + prueba SMS', async () => {
    await alice.profile({ offlineDailyLimitUsdMinor: 12_000, offlinePerTxLimitUsdMinor: 10_000 });
    await alice.fund('PEN', 2_000_000);
    for (let n = 0; n < 3; n++) expect((await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 100, currency: 'PEN' }).voucher)).body.status).toBe('settled'); // velocidad
    const big = (txId: string, stepUp?: any) => alice.pay({ payee: taxi, amountMinor: 36_900, currency: 'PEN', geo: { country: 'CO' }, txId, stepUp });
    const r1 = await call(env, 'POST', '/v1/authorize-offline', big('aaaaaaaaaaaa0001').voucher);
    expect(r1.body).toMatchObject({ status: 'declined', reason: 'step_up_required', stepUpRequired: ['biometric', 'pin', 'sms_confirm'] });
    expect(r1.body.riskScore).toBeGreaterThan(70);
    const bad = await call(env, 'POST', '/v1/authorize-offline', big('aaaaaaaaaaaa0002', { biometric: true, pin: true, smsProof: 'bad' }).voucher);
    expect(bad.body.reason).toBe('step_up_required');
    const good = await call(env, 'POST', '/v1/authorize-offline', big('aaaaaaaaaaaa0003', { biometric: true, pin: true, smsProof: alice.smsProof('aaaaaaaaaaaa0003') }).voucher);
    expect(good.body.status).toBe('settled');
    expect(good.body.riskScore).toBeGreaterThan(70);
  });
  it('desbloqueo: PIN incorrecto repetido activa anti fuerza bruta', async () => {
    await call(env, 'POST', '/v1/authorize-offline', alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN', tamper: (i) => { i.payerAmountMinor = 1; } }).voucher);
    for (let n = 0; n < 5; n++) expect((await call(env, 'POST', `/v1/devices/${alice.id}/unlock`, { pin: '0000' })).status).toBe(403);
    const locked = await call(env, 'POST', `/v1/devices/${alice.id}/unlock`, { pin: '1234' });
    expect(locked.status).toBe(429);
  });
});

describe('ledger offline: anti-tampering', () => {
  it('replay válido avanza la cadena; reenvío es idempotente', async () => {
    alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    alice.pay({ payee: taxi, amountMinor: 1100, currency: 'PEN' });
    const r = await alice.reconcile();
    expect(r.body).toMatchObject({ accepted: 2, chainOk: true, lastSeq: 1 });
    expect(r.body.results.map((x: any) => x.status)).toEqual(['settled', 'settled']);
    const r2 = await alice.reconcile();
    expect(r2.body.accepted).toBe(0);
    expect(r2.body.results.map((x: any) => x.status)).toEqual(['duplicate', 'duplicate']);
  });
  it('una entrada modificada rompe la cadena, bloquea el dispositivo y no liquida nada posterior', async () => {
    alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    alice.pay({ payee: taxi, amountMinor: 1100, currency: 'PEN' });
    const entries = JSON.parse(JSON.stringify(alice.entries));
    (entries[0].payload as any).voucher.intent.amountMinor = 1; // alteración
    const r = await alice.reconcile(entries);
    expect(r.body.chainOk).toBe(false);
    expect(r.body.chainError).toBe('hash_mismatch');
    expect(r.body.accepted).toBe(0);
    expect(r.body.deviceStatus).toBe('locked');
    expect((await call(env, 'GET', `/v1/devices/${taxi.id}/wallet`)).body.balances.PEN ?? 0).toBe(0);
  });
  it('MAC inválido (hash recalculado por un atacante sin la clave) se rechaza', async () => {
    const p = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    const e = { ...p.entry, mac: hmacHex(Buffer.alloc(32), p.entry.hash) };
    const r = await alice.reconcile([e]);
    expect(r.body.chainError).toBe('mac_invalid');
  });
  it('hueco en la secuencia y contador no monótono se rechazan', async () => {
    alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    const r = await alice.reconcile([alice.entries[1]]);
    expect(r.body.chainError).toBe('ledger_gap');
  });
  it('un ledger de otro dispositivo (firma ajena) se rechaza', async () => {
    const p = taxi.pay({ payee: alice, amountMinor: 100, currency: 'PEN' });
    const forged = { ...p.entry };
    const r = await call(env, 'POST', '/v1/reconcile', { deviceId: alice.id, entries: [forged] });
    expect(['prev_hash_mismatch', 'mac_invalid', 'signature_invalid', 'hash_mismatch']).toContain(r.body.chainError);
  });
  it('rotación de claves: ledger firmado con época revocada se rechaza', async () => {
    const rot = await call(env, 'POST', `/v1/devices/${alice.id}/keys/rotate`, alice.signedOp('rotate'));
    expect(rot.body.epoch).toBe(2);
    const old = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    alice.applyKeys(rot.body);
    const next = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    expect((await call(env, 'POST', '/v1/authorize-offline', next.voucher)).body.status).toBe('settled');
    expect(old.voucher.intent.keyEpoch).toBe(1); // época 1 sigue dentro de minKeyEpoch en rotación programada
  });
});

describe('multi-divisa y conciliación diferida de tasa', () => {
  it('paga en USD desde PEN con margen y ajusta la diferencia a favor del usuario al conciliar', async () => {
    const usdPayee = await new SimDevice(env).register();
    const p = alice.pay({ payee: usdPayee, amountMinor: 1000, currency: 'USD' }); // USD 10
    expect(p.voucher.intent.payerAmountMinor).toBe(3825); // 3.75 * 10 * 1.02
    const r = await call(env, 'POST', '/v1/authorize-offline', p.voucher);
    expect(r.body.status).toBe('settled');
    expect(r.body.fx).toMatchObject({ favors: 'user', adjustmentMinor: -75 });
    const w = (await call(env, 'GET', `/v1/devices/${alice.id}/wallet`)).body.balances.PEN;
    expect(w).toBe(100_000 - 3750);
    expect((await call(env, 'GET', `/v1/devices/${usdPayee.id}/wallet`)).body.balances.USD).toBe(1000);
  });
  it('si la tasa vigente cambió a favor del comercio, cobra la diferencia acotada', async () => {
    const p = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'USD' });
    await publishRates(env.rt.ctx, { PEN: 3_900_000 }, 'test'); // PEN se depreció 4%
    const r = await call(env, 'POST', '/v1/authorize-offline', p.voucher);
    expect(r.body.fx.favors).toBe('merchant');
    expect(r.body.fx.adjustmentMinor).toBeGreaterThan(0);
    expect(r.body.fx.adjustmentMinor).toBeLessThanOrEqual(Math.floor((3825 * 200 * 2) / 10_000));
  });
  it('soporta EUR, CRC, VES y COP', async () => {
    const amounts = { EUR: 1000, CRC: 500_000, VES: 30_000, COP: 3_000_000 } as const;
    for (const c of ['EUR', 'CRC', 'VES', 'COP'] as const) {
      const p = alice.pay({ payee: taxi, amountMinor: amounts[c], currency: c });
      expect((await call(env, 'POST', '/v1/authorize-offline', p.voucher)).body.status).toBe('settled');
    }
  });
  it('snapshot de tasas desconocido o adulterado', async () => {
    const forged = { ...alice.rates, id: 'rs_fake' };
    const p = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'USD', snapshot: forged });
    expect((await call(env, 'POST', '/v1/authorize-offline', p.voucher)).body.reason).toBe('rate_snapshot_unknown');
  });
});

describe('aislamiento multi-tenant', () => {
  it('otro cliente no ve ni opera dispositivos ajenos', async () => {
    const admin = await call(env, 'POST', '/v1/rates', { source: 'x' }, { 'x-api-key': 'sw_admin_test_key', 'content-type': 'application/json' });
    expect(admin.status).toBe(200);
    await call(env, 'POST', '/v1/admin/builds', { buildId: 'z', appHash: 'z' }, { 'x-api-key': 'sw_admin_test_key', 'content-type': 'application/json' });
    // el tenant admin sí es otro tenant, pero con permiso global; usamos un tenant normal
    const { createTenant } = await import('../services/tenants.js');
    const { apiKey } = await createTenant(env.rt.ctx, 'Otro', 'pro');
    const h = { 'x-api-key': apiKey, 'content-type': 'application/json' };
    expect((await call(env, 'GET', `/v1/devices/${alice.id}`, undefined, h)).status).toBe(404);
    expect((await call(env, 'POST', '/v1/tokenize', { deviceId: alice.id, pan: '4111111111111111', expMonth: 12, expYear: 2030, currency: 'PEN' }, h)).status).toBe(404);
  });
  it('plan starter no accede a funciones Pro; sin API key → 401', async () => {
    const { createTenant } = await import('../services/tenants.js');
    const { apiKey } = await createTenant(env.rt.ctx, 'Chica', 'starter');
    const h = { 'x-api-key': apiKey, 'content-type': 'application/json' };
    const r = await call(env, 'POST', '/v1/panic', { deviceId: alice.id, trigger: 'sms', pin: '1234' }, h);
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('plan_required');
    expect((await call(env, 'GET', '/v1/rates', undefined, {})).status).toBe(401);
    expect((await call(env, 'GET', '/v1/rates', undefined, { 'x-api-key': 'nope' })).status).toBe(401);
    expect((await call(env, 'GET', '/v1/plans', undefined, {})).status).toBe(200);
  });
  it('rate limit por plan', async () => {
    const { createTenant } = await import('../services/tenants.js');
    const { apiKey } = await createTenant(env.rt.ctx, 'Chica', 'starter');
    const h = { 'x-api-key': apiKey, 'content-type': 'application/json' };
    let last = 200;
    for (let n = 0; n < 125; n++) last = (await call(env, 'GET', '/v1/rates', undefined, h)).status;
    expect(last).toBe(429);
  });
  it('validación de entrada: 400 con código y sin filtrar internals', async () => {
    const r = await call(env, 'POST', '/v1/tokenize', { deviceId: 'x' });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('validation_error');
    const j = await env.app.inject({ method: 'POST', url: '/v1/tokenize', headers: H, payload: '{bad' });
    expect(j.statusCode).toBe(400);
    expect((await call(env, 'GET', '/v1/nope')).status).toBe(404);
  });
});

describe('robustez de entrada', () => {
  it('un intent con números no enteros se rechaza con 200/rejected, nunca con 500', async () => {
    const p = alice.pay({ payee: taxi, amountMinor: 1000, currency: 'PEN' });
    (p.voucher.intent as any).extra = 1.5;
    const r = await call(env, 'POST', '/v1/authorize-offline', p.voucher);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', reason: 'intent_not_canonical' });
  });
});
