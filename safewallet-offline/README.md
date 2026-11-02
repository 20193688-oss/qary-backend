# SafeWallet Offline — MVP fintech + billetera offline‑first con seguridad antifraude

Capa de seguridad B2B (SDK + backend) con una billetera multi‑divisa que **paga sin internet** (Bluetooth, NFC/HCE, QR dinámico, QR EMVCo
tipo Yape/Plin, SMS cifrado) y que, ante un robo como el del caso real (celular desbloqueado, cuentas vaciadas, suplantación en redes,
préstamos fraudulentos, extorsión a contactos), activa el **Protocolo Escudo** en < 3 s, incluso sin red.

> **Estado honesto.** Todo el código está implementado y probado (sin `TODO` ni stubs). Lo que depende de hardware o de terceros
> (Secure Element real, radios BLE/NFC, cámara, Play Integrity/DeviceCheck, pasarelas Yape/Plin, Google/Apple Wallet) está detrás de
> interfaces con implementaciones simuladas deterministas. La tabla exacta de «qué es real / qué se simula» está en
> [`docs/SECURITY.md`](docs/SECURITY.md#1-qué-se-ejecuta-de-verdad-y-qué-se-simula). **No se compiló APK/IPA** (no hay Android SDK/Xcode en el
> entorno de desarrollo): la app se verificó con `flutter analyze` + `flutter test`.

## Qué se verificó (ejecutado, no supuesto)

| Verificación | Resultado |
|---|---|
| Backend: `tsc` + 71 tests (unit, integración, contrato OpenAPI) en memoria | 71 / 71 ✔ |
| Backend: los mismos 71 tests contra **PostgreSQL 16 + Redis 7 reales** | 71 / 71 ✔ |
| Backend compilado (`node dist/index.js`) sobre BD vacía + recorrido de **todos** los endpoints con cURL | ✔ |
| App: `flutter analyze` | sin avisos |
| App: 71 tests (cripto, agentes, sesiones BLE/NFC, Escudo, anti‑reversa, UI, vectores cruzados TS↔Dart) | 71 / 71 ✔ |
| **Integración real Dart ↔ backend** (onboarding, BLE, doble gasto por clon, ledger manipulado, QR, SMS, EMV, Escudo, forense, app completa) | ✔ |
| `docker compose` | `docker compose config` válido; **las imágenes no se construyeron aquí** (sin daemon Docker en el entorno): el equivalente se ejecutó con Postgres/Redis locales y el build compilado |

## Instalación

### Opción A — Docker (recomendada)
```bash
cd safewallet-offline
docker compose up --build            # postgres + redis + backend en http://localhost:3000
curl http://localhost:3000/health    # {"status":"ok",...}
scripts/seed-rates.sh                # (opcional) publica un snapshot de tasas firmado
BASE_URL=http://localhost:3000 scripts/curl-examples.sh   # recorre todos los endpoints
```
No requiere configuración: el *secret manager* (mock) genera y persiste secretos en el volumen `swdata`. Variables opcionales en `.env.example`.

### Opción B — sin Docker (Node 22+, y opcionalmente Postgres/Redis)
```bash
cd safewallet-offline/backend
npm ci
npm run dev                                   # memoria + KV en memoria (desarrollo)
# con servicios reales:
DATABASE_URL=postgres://user:pw@localhost:5432/safewallet REDIS_URL=redis://localhost:6379 npm run dev
```

### App móvil (Flutter ≥ 3.13 / Dart ≥ 3.13)
```bash
cd safewallet-offline/mobile
flutter pub get
flutter run --dart-define=SW_API_URL=http://10.0.2.2:3000 --dart-define=SW_API_KEY=sw_sandbox_demo_key   # 10.0.2.2 = host del emulador Android
```
Flujo en la app: **Activación** (PIN, PIN de coacción, contacto de confianza, tarjeta) → *Recargar (sandbox)* → pagar por **Bluetooth / NFC / QR dinámico /
QR Yape sin red / SMS** contra un «taxista virtual» incluido en la demo → **Recuperé red: sincronizar** (replay del WAL) → **PÁNICO** (mantener presionado).
Las confirmaciones biométricas, la radio BLE/NFC y el envío de SMS se simulan en la demo (ver SECURITY.md).

Compilación de producción ofuscada (requiere SDK Android/Xcode): `SW_API_URL=... SW_API_KEY=... scripts/build-release.sh`.

## Pruebas
```bash
scripts/run-tests.sh                                  # backend (memoria) + app Flutter con integración real contra un backend efímero
TEST_DATABASE_URL=postgres://sw:sw@localhost:5432/swtest TEST_REDIS_URL=redis://localhost:6379 scripts/run-tests.sh   # + servicios reales
# por separado:
(cd backend && npm test)                              # 71 tests
(cd mobile && flutter test)                           # 61 tests + integración (se omite sin SW_BACKEND_URL)
(cd mobile && SW_BACKEND_URL=http://localhost:3000 flutter test test/integration_backend_test.dart)   # contra el backend ya levantado
```

## Mapa requisito → módulo → prueba → documento

| Requisito del documento | Módulo | Prueba | Doc |
|---|---|---|---|
| Offline‑first, ledger firmado, contador monotónico | `dual_agent/offline_agent.dart`, `services/payments.ts` | `agent_test`, `payments.test` («ledger offline: anti‑tampering») | ARCHITECTURE |
| Doble agente + bus + WAL cifrado + replay y rechazo de doble gasto | `dual_agent/*` | `integration_backend_test` («doble gasto… clonado»), `agent_test` (restore, WAL) | ARCHITECTURE §Doble agente |
| Cripto real: ECDSA, AES‑GCM, HKDF, double ratchet, SE | `core/crypto`, `core/secure_element` | `crypto_vectors_test`, `session_test` | SECURITY §1‑2 |
| Tokenización DPAN + ARQC | `services/tokenization.ts` | `payments.test` («tokenización») | SECURITY §1 |
| Pago Bluetooth LE | `features/ble_pay` | `session_test` | ARCHITECTURE §Canales |
| Pago NFC / HCE | `NfcApdu` | `session_test` («NFC…») | ARCHITECTURE |
| QR dinámico firmado, multi‑divisa | `features/qr_dynamic`, `/v1/qr/dynamic` | `security.test` («QR dinámico»), `features_test` | API |
| QR EMVCo (Yape/Plin) + pago diferido + pasarela mock | `features/qr_interop`, `/v1/qr/emv/*` | `security.test` («EMVCo»), `features_test` | API, SECURITY §1 |
| Transferencia por contacto / SMS cifrado | `features/sms_fallback`, `services/sms.ts` | `security.test` («SMS cifrado»), `features_test` | API |
| Cross‑border ±2 % y conciliación diferida de tasa | `multi_currency/fx.dart`, `services/rates.ts` | `payments.test` («multi‑divisa»), vectores TS↔Dart | SECURITY §4 |
| Protocolo Escudo (botón, coacción, SMS, remoto) | `core/panic/shield.dart`, `services/panic.ts` | `panic_test`, `security.test` («Protocolo Escudo») | SECURITY §5 |
| Bloqueo de préstamos / anti‑suplantación (72 h firmado) | `risk-flags`, webhooks | `security.test` | SECURITY §6 |
| Auditoría forense (hash chain) y canal de denuncia | `core/panic/forensic_log.dart`, `services/forensic.ts` | `security.test`, `panic_test` | SECURITY §9 |
| Geofencing, clonación, testamento digital | `Geofence`, `observeSighting`, `DeadManSwitch` | `security.test`, `panic_test` | SECURITY §5, §8 |
| Reportes horario/diario/semanal/mensual/anual firmados | `services/reports.ts` | `security.test` («reportes firmados») | API |
| Google Pay / Apple Pay | `wallet_guard`, `/v1/wallets/provision` | `payments.test`, `panic_test` | SECURITY §7 |
| Anti‑reversa (ofuscación, Frida/emulador, integridad) | `core/integrity`, `proguard-rules.pro`, `build-release.sh` | `panic_test` («anti‑reversa») | SECURITY §8 |
| Score de riesgo, biometría continua, PIN de coacción, rotación de claves, rate limit | `risk.ts/dart`, `BehaviorMonitor`, `PinVault` | varios | SECURITY §9 |
| API `/v1/*` + OpenAPI 3.1 + contrato | `api/routes.ts` → `docs/openapi.json` | `security.test` («contrato OpenAPI») | API |
| Modelo B2B, PI, patente | `tenants.ts`, `LICENSE` | `payments.test` («plan starter…») | BUSINESS_PLANS |

## Modelo de negocio, propiedad intelectual y aviso legal
* Planes **Starter / Pro / Enterprise**, aplicados en código (403 `plan_required`, 429 por plan): [`docs/BUSINESS_PLANS.md`](docs/BUSINESS_PLANS.md).
* **Propiedad Intelectual (recomendación, no asesoría legal)**: registrar marca en INDECOPI; solicitar patente de invención en INDECOPI y vía **PCT** para el *método* de
  «doble agente offline‑online con conciliación diferida y Protocolo Escudo» (las ideas de software no se patentan en abstracto: se protege el método técnico);
  consultar a un abogado de PI **antes de divulgar**; depositar el código con sello de tiempo notarial; NDA con clientes; licencia dual (open core + comercial).
* **Aviso legal anti‑reversa** ([`LICENSE`](LICENSE)): prohíbe ingeniería inversa, elusión de protecciones, extracción de modelos, uso para entrenamiento de IA y clonación.
  **Expectativa realista:** ninguna app es 100 % incopiable. La mitigación real es **hardware (Secure Element) + attestation + servidor de confianza**;
  la ofuscación y la licencia solo elevan el costo y habilitan acciones legales.

## Límites que debes conocer antes de producción
1. El offline **siempre** tiene exposición acotada (límite diario/por operación): no existe offline ilimitado seguro.
2. Un DPAN de SafeWallet no lo aceptan POS de Visa/Mastercard sin ser emisor/TSP certificado; Yape/Plin necesitan acuerdo con su pasarela.
3. Sin Secure Element real y Play Integrity/App Attest, la custodia de claves es software (ver SECURITY).
4. El kill‑switch por SMS en Android necesita el receptor nativo de referencia (`docs/native-reference/SosSmsReceiver.kt`, no compilado aquí); en iOS no hay SMS en segundo plano.
5. No se implementaron: marca de agua de pantalla / `FLAG_SECURE`, anclaje en blockchain pública, biometría del SO (`local_auth`).
6. Cumplimiento: PCI‑DSS, SBS (billeteras), Ley 29733.

## Documentación
[`ARCHITECTURE`](docs/ARCHITECTURE.md) (diagramas Mermaid) · [`SECURITY`](docs/SECURITY.md) · [`API`](docs/API.md) + [`openapi.json`](docs/openapi.json) · [`THREAT_MODEL`](docs/THREAT_MODEL.md) · [`BUSINESS_PLANS`](docs/BUSINESS_PLANS.md)
