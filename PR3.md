# PR 3 — Auth real + Stripe sandbox + voice‑confirm

> Branch: `claude/super-app-scaffold-gMX6q` · Title: `feat(auth+payments): Stripe sandbox + auth real (PR3)`

## Resumen

- Auth completo: `register → OTP (Redis TTL) → verify-otp` emite JWT (15 m) + refresh rotativo en DB con revocación; `login` opcional con password; `refresh` rota; `logout` revoca; `me` y `pin` autenticados.
- Stripe sandbox: `PaymentIntent` (manual capture) + webhooks con verificación de firma + idempotencia por `event.id` + `Event` audit.
- Receipts: `GET /api/receipts/:id` retorna JSON o HTML, con HMAC‑SHA256 sobre el payload.
- Voice‑confirm: `POST /api/voice-confirm` verifica PIN bcrypt, marca `voicePinVerified`, captura el intent y devuelve mensaje TTS + `receiptUrl`.
- Tests Vitest **16/16 verde** con Prisma + Redis + Stripe mockeados.
- CI ahora bloquea merge si tests/typecheck/build fallan.
- `release.yml` produce **PWA dist** + **APK Android** (debug siempre; release si hay keystore secrets).

## Archivos modificados

```
backend/package.json
backend/prisma/schema.prisma
backend/src/app.ts                 (nuevo, factory para tests)
backend/src/server.ts              (usa buildApp)
backend/src/lib/auth-plugin.ts     (nuevo)
backend/src/lib/audit.ts           (nuevo)
backend/src/lib/crypto.ts          (nuevo, hmac/sha256/random)
backend/src/lib/jwt.ts             (nuevo)
backend/src/lib/otp.ts             (nuevo)
backend/src/lib/password.ts        (nuevo)
backend/src/lib/redis.ts           (nuevo)
backend/src/lib/stripe.ts          (nuevo)
backend/src/routes/auth.ts         (rewrite completo)
backend/src/routes/payments.ts     (nuevo)
backend/src/routes/webhooks.ts     (nuevo)
backend/src/routes/receipts.ts     (nuevo)
backend/src/routes/voice-payment.ts (nuevo)
backend/test/_mocks.ts             (nuevo)
backend/test/setup.ts              (nuevo)
backend/test/auth.test.ts          (nuevo)
backend/test/payments.test.ts      (nuevo)
backend/test/voice-payment.test.ts (nuevo)
backend/vitest.config.ts           (nuevo)
frontend/src/App.tsx               (ruta /pay/:orderId)
frontend/src/lib/api.ts            (nuevo, cliente fetch + tokens)
frontend/src/lib/voice.ts          (nuevo, Web Speech API)
frontend/src/screens/Otp.tsx       (cableado a backend real)
frontend/src/screens/VoicePay.tsx  (nuevo)
.env.example                       (HMAC_SECRET, BCRYPT_ROUNDS)
.github/workflows/ci.yml           (postgres+redis services + tests bloqueantes)
.github/workflows/release.yml      (nuevo: PWA + APK + GitHub Release)
scripts/simulate_payments.js       (nuevo)
PR3.md                             (este archivo)
```

## Levantar local

```bash
pnpm install
pnpm --filter backend exec prisma generate
pnpm infra:up                   # postgres, redis, minio, mailhog, coturn
pnpm --filter backend exec prisma migrate dev --name init
pnpm --filter backend exec prisma db seed   # demo user + driver
pnpm dev                        # frontend :5173 + backend :3000
```

## Probar pagos con tarjeta de prueba

1. Crea un account de Stripe sandbox y copia las claves a `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PUBLISHABLE_KEY=pk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...   # rellénalo con `stripe listen` o tras crear endpoint
   ```
2. Levanta `stripe listen --forward-to localhost:3000/api/webhooks/stripe` (CLI de Stripe). Copia el `whsec_*` que imprime al `.env` y reinicia el backend.
3. Tarjeta de prueba: `4242 4242 4242 4242`, exp `12/34`, CVC `123`, ZIP cualquiera.
4. Demo end‑to‑end con script (necesita un `orderId` real; PR 4 lo crea automático):
   ```bash
   node scripts/simulate_payments.js --orderId <ID> --email demo@qary.local
   ```

## Probar pago por voz

1. Logea en la PWA, ve a `/pay/<orderId>`.
2. Pulsa **🎙️ Decir mi PIN** y dí, por ejemplo, **"cuatro dos cuatro dos"** o **"4242"**.
3. El cliente envía POST `/api/voice-confirm` con `{orderId, userId, confirmPin}`.
4. Backend valida PIN bcrypt → captura PaymentIntent → responde con `ttsConfirmation`.
5. La pantalla reproduce el mensaje y muestra link al recibo HTML.

> Si el navegador no soporta Web Speech API, hay fallback con teclado numérico.
> Rate‑limit: 5 intentos fallidos / 60 s por usuario.

## Probar webhooks desde móvil/cualquier red

```bash
ngrok http 3000
# copia la URL https → en Stripe Dashboard → Webhooks → endpoint
#   <ngrok>/api/webhooks/stripe   evento: payment_intent.*
# o `stripe listen --forward-to <ngrok>/api/webhooks/stripe`
```

## Artefactos (después de crear el PR y mergear / pushear tag)

| Artefacto | Cómo | Nota |
|---|---|---|
| **APK debug** | Workflow `release.yml` → job `apk`, descarga `qary-apk` artifact | Siempre se genera (sin firmar). `adb install qary-debug.apk` |
| **APK signed (release)** | Mismo workflow + agregar secrets de keystore | Ver tabla de secrets abajo |
| **PWA staging** | Workflow `release.yml` → job `pwa`, opcional Vercel deploy | Sin `VERCEL_*`, queda como artifact descargable |
| **Expo URL/QR** | `cd mobile && pnpm start` (local, requiere LAN o `--tunnel`) | Sin EAS; si quieres APK firmado vía EAS, usa `eas build` con tu cuenta |

### Secrets para el workflow `release.yml`

Agregar en **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Para qué |
|---|---|
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` | Deploy PWA (opcional). Sin esto, el PWA queda como artifact descargable. |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 release.keystore`. Sin esto, sólo APK debug. |
| `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` | Datos del keystore. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Sólo si tu CI corre tests contra Stripe real (no es el caso aquí; los tests están mockeados). |

Si no agregas keystore secrets, el workflow sigue exitoso y produce APK **debug** (suficiente para `adb install` y demo). El bundle release queda pendiente.

### Generar keystore una vez (si quieres APK firmado)

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore release.keystore -alias qary \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.keystore                 # copia el output a ANDROID_KEYSTORE_BASE64
```

## Instalar APK desde el móvil (sin laptop)

1. En GitHub → tu Actions run → **Artifacts** → descarga `qary-apk.zip` desde el móvil.
2. Descomprime y abre el APK en Android: aprueba "Instalar de fuentes desconocidas" si te lo pide.
3. O por adb (USB):
   ```bash
   adb install -r qary-debug.apk
   ```
4. La app abre WebView contra `EXPO_PUBLIC_PWA_URL` (default `http://10.0.2.2:5173`); en producción apunta a tu PWA staging URL.

## Checklist seguridad PR 3

- [x] `.env` jamás commiteado; sólo `.env.example`.
- [x] Webhook Stripe rechaza si falta `STRIPE_WEBHOOK_SECRET` o firma inválida.
- [x] Refresh tokens almacenados como `sha256(raw)`, raw nunca persiste.
- [x] PIN almacenado como bcrypt; rate‑limit de 5 intentos / minuto.
- [x] PaymentIntent en `manual capture` — sólo se captura tras `voicePinVerified=true`.
- [x] Receipts firman payload con HMAC‑SHA256 (`HMAC_SECRET`).
- [x] Audit `Event` con `requestId`, `ip`, `userAgent` para cada acción sensible.
- [x] Tests bloqueantes en CI.
