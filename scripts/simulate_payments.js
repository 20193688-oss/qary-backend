#!/usr/bin/env node
// Simula un flujo de pago end-to-end contra el backend en sandbox:
//  1. registra usuario + verifica OTP (debug otp en non-prod)
//  2. setea PIN
//  3. crea order via SQL/Prisma seed implícito (usa ORDER_ID si lo pasas)
//  4. crea PaymentIntent (manual capture)
//  5. confirma por voz (PIN) → captura
//  6. obtiene receipt JSON + HTML
//
// Usage:
//   node scripts/simulate_payments.js [--api http://localhost:3000] [--email demo+pay@qary.local]
// Requiere que el backend esté corriendo y un orderId existente. Si no pasas
// --orderId el script crea un order vía /api/orders (PR 4) o falla con instrucciones.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const API = args.api ?? process.env.API_BASE_URL ?? 'http://localhost:3000';
const email = args.email ?? `demo+${Date.now()}@qary.local`;
const orderId = args.orderId;
const PIN = '4242';

async function j(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return json;
}

async function run() {
  console.log(`[sim-pay] API=${API} email=${email}`);

  const reg = await j('POST', '/api/auth/register', { email, password: 'longpass1' });
  console.log('[sim-pay] registered:', reg.userId, 'debugOtp:', reg.debugOtp);

  const verify = await j('POST', '/api/auth/verify-otp', { email, code: reg.debugOtp });
  const access = verify.accessToken;
  const userId = verify.user.id;

  await j('POST', '/api/auth/pin', { pin: PIN }, access);
  console.log('[sim-pay] pin set');

  if (!orderId) {
    console.error(
      '[sim-pay] No --orderId provided. Cuando PR 4 cablee /api/orders, este script creará uno solo.\n' +
      '          Por ahora, crea el order manualmente:\n' +
      '          $ pnpm --filter backend exec prisma studio  → tabla Order, INSERT con userId=' + userId,
    );
    process.exit(2);
  }

  const intent = await j('POST', '/api/payments/intent', { orderId, amountCents: 2500 }, access);
  console.log('[sim-pay] intent:', intent.paymentId, intent.clientSecret?.slice(0, 24) + '…');

  const conf = await j('POST', '/api/voice-confirm',
    { orderId, userId, confirmPin: PIN }, access);
  console.log('[sim-pay] voice confirm:', conf.status, conf.ttsConfirmation);
  if (!conf.ok) process.exit(1);

  const receipt = await j('GET', conf.receiptUrl, null, access);
  console.log('[sim-pay] receipt:', receipt.receiptId, 'sig:', receipt.signature.slice(0, 16) + '…');

  // HTML
  const htmlRes = await fetch(`${API}${conf.receiptUrl}`, { headers: { accept: 'text/html', authorization: `Bearer ${access}` } });
  console.log('[sim-pay] receipt html status:', htmlRes.status, 'bytes:', (await htmlRes.text()).length);
  console.log('\n[sim-pay] OK ✅  Pago capturado y recibo emitido.');
}

run().catch((e) => { console.error('[sim-pay] FAIL', e.message); process.exit(1); });
