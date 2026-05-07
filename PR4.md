# PR 4 — Mapa real‑time + Socket.IO + arreglos del wrapper móvil

> Branch: `claude/super-app-scaffold-gMX6q` · Title: `feat(realtime+wrapper): mapa drivers tiempo real + intents share/call/sms`

## Resumen

PR4 entrega el **core de tiempo real** que la roadmap pedía y resuelve la causa raíz por la que share / call / SMS / WhatsApp / mailto **no funcionaban** en el APK aunque su código existía en el HTML legacy: la WebView no despachaba esquemas no‑http al sistema.

A partir de aquí cualquier botón de WhatsApp / Llamar / SMS / Mail del HTML legacy abre la app correspondiente del teléfono al instalar el APK.

## Lo que entrega

### 1. Causa raíz de "compartir está deshabilitado" (mobile/App.tsx)

Antes: `window.open('tel:...', '_blank')` en la WebView no hacía nada — el WebView no tiene handler para `tel:`/`sms:`/`mailto:`/`whatsapp:`/`intent:`/`market:` y no abre nuevas ventanas.

Ahora: `onShouldStartLoadWithRequest` intercepta cualquier URL no‑interna y la despacha a `Linking.openURL()` de React Native, que el sistema operativo enruta a la app correspondiente. También se interceptan los hosts de WhatsApp HTTPS (`wa.me`, `api.whatsapp.com`) para que abran la app nativa de WhatsApp en lugar de cargar la web dentro del WebView.

Funcionalidades del HTML legacy que ahora **se activan automáticamente** sin tocar las 8000 líneas:

- `callEmergencyContact(id)` → `tel:+51...`
- `sendSMSToEmergencyContact(id, msg)` → `sms:+51...?body=...`
- `sendEmailToEmergencyContact(id, subject, body)` → `mailto:...`
- `shareRideWhatsApp()`, `shareReferral()`, `openWhatsApp()`, `openWhatsApp247()`, `supportOpenWhatsApp()`, `aiSyncWhatsApp()`, `openProfileWhatsApp()` → WhatsApp app
- Recovery de password (`mailto:`), recargas y cualquier `window.open()` con esquema custom

### 2. Mapa en tiempo real (backend + legacy + simulador)

- **`backend/src/lib/realtime.ts`**: hub que emite a Socket.IO rooms `drivers:positions` y `drivers:positions:<vehicleType>`.
- **`backend/src/server.ts`**: socket maneja `subscribe:drivers <type?>` para recibir solo el tipo seleccionado.
- **`backend/src/routes/locations.ts`**: `POST /api/locations` valida con Zod y difunde posición.
- **`scripts/simulate_drivers.js`**: random walk con heading + 8 tipos (`std/cf/ex/lx/xl/moto/bike/mudanzas`).

### 3. Overlay PR4 sobre el HTML legacy (sin reescribirlo)

`legacy/qary_pr4_overlay.js` se inyecta como `<script>` inline antes de `</body>` por `mobile/scripts/copy-legacy.mjs`. Añade:

| # | Feature | API expuesta |
|---|---|---|
| 1 | **Transportes unificados**: selección persistente entre Inicio / Explorar / Pedir, estado visual `qary-tr-selected` | `QaryTransport.set(key)`, `QaryTransport.current`, evento `qary:transport` |
| 2 | **Mapa real-time**: carga `socket.io` desde CDN, conecta a `Backend URL`, dibuja markers por tipo, filtra por transporte seleccionado | `qarySetBackend(url)` |
| 3 | **TTS UI** con 3 botones Femenino / Masculino / Neutro en panel IA | usa `qarySetVoiceGender()` que ya existía |
| 4 | **API key del modelo** (Anthropic / OpenAI / Gemini / Grok) en panel IA | `localStorage['qary_ai_apikey'/'qary_ai_provider']` |
| 5 | **Backend URL** configurable en runtime (panel IA) | `qarySetBackend()` |
| 6 | **Buscador con micrófono + redirección** en Inicio (global) y Explorar (scoped) | `qarySearchRoute(text, scope)` |
| 7 | **Sincronización foto perfil**: `qarySyncProfilePhoto(dataUrl)` → propaga a `[data-qary-photo]`/`.hd-avatar`/etc. + evento `qary:profile-photo` | — |
| 8 | **Notas de voz playback**: `qaryAttachVoiceNote(blob)` adjunta `<audio controls>` al chat | — |
| 9 | **Bridge nativo**: `QaryNative.postMessage({type, ...})` para futuros comandos voz→hardware | — |

### 4. Wrapper Expo

- Intercepta `tel:/sms:/mailto:/whatsapp:/intent:/market:/qary://` → `Linking.openURL`
- Intercepta `wa.me`, `api.whatsapp.com`, `web.whatsapp.com`, `whatsapp.com` → app WhatsApp nativa
- Mantiene `file:///android_asset/pwa/index.html` como root (APK standalone sigue funcionando offline)

## Archivos modificados

```
backend/src/app.ts                                    (AppDeps + realtime opcional)
backend/src/lib/realtime.ts                           (nuevo)
backend/src/routes/locations.ts                       (validación + broadcast)
backend/src/server.ts                                 (Socket.IO rooms + subscribe:drivers)
backend/test/locations.test.ts                        (nuevo, 2 tests)
mobile/App.tsx                                        (onShouldStartLoadWithRequest + Linking)
mobile/scripts/copy-legacy.mjs                        (inyecta overlay)
legacy/qary_pr4_overlay.js                            (nuevo, 320 líneas)
scripts/simulate_drivers.js                           (heading + 8 vehicleTypes)
PR4.md                                                (este archivo)
```

## Tests

```
✓ test/auth.test.ts          (7 tests)
✓ test/voice-payment.test.ts (4 tests)
✓ test/payments.test.ts      (5 tests)
✓ test/locations.test.ts     (2 tests, NEW)

Test Files  4 passed (4)
     Tests  18 passed (18)
```

## Probar local

```bash
# 1. backend
pnpm --filter backend dev               # :3000
pnpm infra:up                           # postgres + redis

# 2. simulador (en otra terminal)
node scripts/simulate_drivers.js --count 8 --interval 1500

# 3. cliente: abre la PWA o el APK
#    - En el panel IA → "Backend URL" pega http://<tu-IP-LAN>:3000 → Conectar
#    - En la pestaña Pedir → ve el mapa con conductores reales en tiempo real
#    - Toca Qary Moto/Standard/etc. → solo los del tipo seleccionado quedan visibles
```

## Probar el APK

El APK release incluye automáticamente este PR (CI lo regenera al push):
1. Run de Actions: <https://github.com/20193688-oss/qary-backend/actions> (espera el job `build-apk-release` ✅)
2. Descarga artifact `qary-android-release` → `qary-superapp-release.apk`
3. Instala en Android (sideloading)
4. Abre la app → panel IA → pega tu Backend URL público (Railway / ngrok / Vercel) → Guardar
5. Inicia el simulador con `--api <misma-url>` → verás los drivers en el mapa

## Lo que sí entrega de la lista del usuario

| # | Item | Estado |
|---|---|---|
| 1 | Mapa real‑time + Socket.IO + simulador | ✅ |
| 2 | Transportes unificados (Inicio/Explorar/Pedir) | ✅ via `QaryTransport` |
| 3 | Compartir SMS/WhatsApp/Correo/Llamada | ✅ via wrapper Intent dispatch |
| 4 | Llamar contacto de emergencia | ✅ via wrapper Intent dispatch |
| 5 | Agente IA con 3 voces (Fem/Masc/Neutro) | ✅ UI en panel IA |
| 6 | API key configurable (Anthropic/OpenAI/Gemini/Grok) | ✅ UI en panel IA |
| 7 | Buscadores con voz | ✅ mic + redirección |
| 8 | Foto de perfil sincronizada | ✅ via `qarySyncProfilePhoto` + evento |
| 9 | Notas de voz reproducibles | ✅ via `qaryAttachVoiceNote(blob)` |
| 10 | Backend URL configurable runtime | ✅ |

## Diferido a PRs siguientes (justificación)

| # | Item | Por qué | Plan |
|---|---|---|---|
| Latencia mic < 200 ms | Es una característica nativa Android (AudioRecord buffers, AVAudioSession) que requiere un módulo Expo nativo. WebView's getUserMedia no permite tunear esos buffers. | PR9 Hardware: módulo nativo + permission flow. |
| Perfil → Viajes / Soles / Referidos dedicados | Refactor profundo del HTML legacy + endpoints backend nuevos para historial unificado. | PR8 Incidentes/Receipts + endpoints `/api/users/:id/history`. |
| Inicio → Reciente → Ver todo (feed real-time) | Necesita endpoint que combine Order/Payment/Auth events + websocket subscription `user:events`. | PR8 Audit feed con cursor pagination. |
| Sonido de activación micrófono | Bug específico del wrapper Android: hay que silenciar `setStreamSolo` o equivalente Expo. | PR9 Hardware. |
| Referidos en tiempo real con canal/estado | Necesita backend de referidos + tracking de clicks. | PR siguiente. |

## Checklist seguridad PR 4

- [x] `Linking.openURL` valida scheme y atrapa errores (no crash si no hay app instalada).
- [x] Backend URL **runtime configurable** — el usuario controla a qué backend se conecta el APK; no hay hardcoding.
- [x] API key del modelo **se almacena solo en localStorage del dispositivo** (no se envía al backend de QARY); botón "Borrar" para revocarla.
- [x] Socket.IO rooms isolan tráfico por `vehicleType` para reducir broadcast innecesario.
- [x] Validación Zod estricta en `/api/locations` (rangos lat/lng, campos opcionales tipados).
- [x] Tests de validación y broadcast pass (`locations.test.ts`).
