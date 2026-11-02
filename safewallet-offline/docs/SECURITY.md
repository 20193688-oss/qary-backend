# Seguridad: decisiones, justificación y límite real

> Regla de este documento: cada control dice **qué hace de verdad**, **qué se simula en el MVP** y **dónde termina su protección**.
> Ninguna aplicación es 100 % incopiable ni invulnerable. La mitigación real es **hardware + attestation + servidor de confianza**.

## 1. Qué se ejecuta de verdad y qué se simula

| Componente | Estado en el MVP | Detalle |
|---|---|---|
| ECDSA P-256, ECDH, HKDF, AES-256-GCM, HMAC/SHA-256 | **Real** | Backend: `node:crypto`. App: `pointycastle` (ECDSA/ECDH, firmas deterministas RFC 6979) + `cryptography` (AES-GCM/HKDF/HMAC). Interoperabilidad Dart↔Node verificada con vectores y en integración. |
| Double ratchet de sesiones BLE/NFC | **Real** | Forward secrecy por mensaje, claves destruidas tras usarse, replay rechazado. |
| Ledger firmado y encadenado (hash + HMAC + ECDSA + contador monotónico) | **Real** | El backend verifica los tres, la continuidad y el contador; cualquier alteración rompe la cadena. |
| Tokenización DPAN + criptograma ARQC | **Real (emisor propio)** | DPAN Luhn-válido de un solo uso; ARQC = HMAC(LUK, datos). **No** es una red de pagos certificada: un DPAN de SafeWallet no es aceptado por un POS Visa/Mastercard. |
| **Secure Element / StrongBox / Secure Enclave** | **SIMULADO** | `SoftwareSecureElement` mantiene el contrato (la app nunca ve claves privadas ni simétricas; solo firma/HMAC/AEAD) pero **sin aislamiento de hardware**. En un teléfono real hay que sustituirlo por Android Keystore (StrongBox) / Secure Enclave vía MethodChannel. Los tests no pueden validar el hardware. |
| Attestation de plataforma (Play Integrity / DeviceCheck) | **SIMULADO** | El backend acepta `integrityToken` que empiece por `MOCK-OK`. La interfaz (`verifyPlatformToken`) está aislada para conectar los verificadores reales. Sí es real: firma de la attestation con la clave del dispositivo, challenge de un solo uso, build/hash registrados, rooted/emulator/hooked/debuggable. |
| BLE / NFC-HCE / cámara QR / SMS / biometría / GPS | **Capa de protocolo real, E/S SIMULADA** | Todo el protocolo (handshake, cifrado, framing BLE, APDU, SWPAY1) está implementado y probado sobre `PeerTransport`/`SmsGateway`. El acople a radios y sensores requiere plugins de plataforma y hardware; la app los reemplaza por `LoopbackTransport`, `RecordingSmsGateway` y confirmaciones simuladas en la demo. |
| Pasarela Yape/Plin | **MOCK** | El adaptador EMVCo y el enrutamiento son reales; `mockGatewayPay` es determinista. Requiere acuerdo con Niubiz/Izipay/billetera. |
| Centrales de riesgo, Meta/X/WhatsApp, bancos | **Webhooks + API firmada** | Entrada `POST /v1/webhooks/fraud` (HMAC) y salida firmada (`fraud.*`, `identity.compromised`, `loan.block_requested`). Los destinatarios reales no están integrados. |
| Google Pay / Apple Pay | **Aprovisionamiento SIMULADO** | Ver §7. |
| WAL «en SQLite cifrado» | **Variante** | WAL append-only de registros AES-256-GCM (un archivo/almacén de líneas) en lugar de SQLite: mismas garantías (confidencialidad, integridad, orden por AAD) sin dependencia nativa. |
| Anclaje en blockchain pública | **No implementado (opcional)** | Se usa log append-only firmado con cadena de hashes (`log:*`, `reports:*`, `forensic:*`). La cabeza de la cadena puede anclarse externamente; límite: sin ancla externa, quien controle el servidor podría reescribir el log completo. |

## 2. Custodia de claves
* **Decisión**: la clave privada ECDSA y las claves simétricas (ledger MAC, SMS, LUK, WAL) viven dentro de la abstracción `SecureElement`; las simétricas llegan envueltas con ECIES (P-256 efímera + HKDF + AES-GCM) y se desempaquetan *dentro* del SE.
* **Backend**: no almacena claves por dispositivo; las deriva con HKDF del secreto maestro (`ledger-mac|época`, `sms|época`, `luk|token|época`). El PAN **nunca** se almacena (solo `cardRef` HMAC y últimos 4).
* **Rotación**: cada 24 h (`/keys/rotate`, firmada) o por evento de riesgo (el Escudo sube `minKeyEpoch`, invalidando MAC/ARQC/LUK anteriores).
* **Límite**: en software, un atacante con root podría extraer claves de memoria. Por eso la attestation bloquea rooted/emulador/Frida y la protección real exige SE/StrongBox.

## 3. Pagos offline y doble gasto
* **Decisión**: se acepta riesgo acotado, no ilimitado. Límites duros en el dispositivo *y* en el servidor (diario USD 200 por defecto, por operación, por país, comercio no listado ÷4, techo configurable `MAX_OFFLINE_LIMIT_USD_MINOR`).
* **Anti doble gasto**: token de un solo uso, contador monotónico por pagador (`counters`, inserción atómica), `txId` idempotente, serialización por pagador (lock Redis). Exceder límite, reutilizar token/contador o manipular tasa ⇒ bloqueo preventivo (`locked`) + SMS al usuario + webhook.
* **Límite real**: un dispositivo comprometido *antes* de bloquearse puede gastar hasta su límite offline; el cobrador offline asume ese riesgo residual (acotado). El backend **no puede** impedir gasto simultáneo en dos comercios *offline* antes de conciliar; sólo detectarlo y bloquear.
* **Score de riesgo 0‑100** (idéntico en Dart y TS, con vectores): >70 exige biometría + PIN + prueba SMS (HMAC con la clave SMS del SE).

## 4. Tasas y multi‑divisa
Snapshot diario firmado por el servidor (base USD, enteros ×1e6, sin floats), verificable offline; fallback a referencias estáticas si la fuente (BCE) no responde. Margen ±2 %: el pagador ve el precio con margen; al conciliar, el servidor calcula el precio justo con la tasa vigente y ajusta la diferencia (a favor del usuario o del comercio) acotada a ±2 × margen. Límite: la tasa precargada puede quedar vieja (se bloquea tras 24 h de gracia).

## 5. Protocolo Escudo
Activaciones: botón (long‑press), PIN de coacción, SMS `SAFE-SOS-<PIN>`, web remota con PIN, testamento digital, geofence.
Pasos en el dispositivo (< 3 s, sin red; medido en tests): firma y **encola** el pánico → congela ledger → revoca tokens → SMS firmado a contactos (crédito del chip) → **borra el SE**.
En el servidor: revoca tokens, sube época de claves, `sessionEpoch++`, ordena `SE_WIPE/FREEZE_LEDGER/INVALIDATE_SESSIONS`, emite **bandera de riesgo firmada de 72 h** (consultable por bancos/centrales/Meta/X/WhatsApp), webhooks y log forense.
* **PIN de coacción**: abre billetera señuelo (saldos falsos), alerta silenciosa; el atacante no ve diferencia.
* **Kill‑switch SMS**: el gateway entrega el SMS entrante a `/v1/sms/inbound`. En Android la app necesita un `BroadcastReceiver` nativo (referencia en `docs/native-reference/SosSmsReceiver.kt`, **no compilado en este entorno**). En iOS no hay SMS en segundo plano: se usa push o la API web (`remote_web`).
* **Anti fuerza bruta**: 5 PIN erróneos ⇒ 15 min de bloqueo (Redis; en el dispositivo, persistido en el WAL).
* **Pánico offline firmado**: el servidor acepta pánicos firmados con hasta 7 días de antigüedad (es una acción de protección y se entrega horas después).
* **Límites reales**: si el atacante apaga el teléfono antes del pánico, el SE no se borra hasta que el backend entregue `SE_WIPE` al volver a la red (las claves quedan revocadas del lado servidor de inmediato: sin ARQC/LUK vigentes los vouchers no se liquidan). No se puede impedir que roben el celular ni bloquear canales de denuncia ajenos; sí limitar el daño financiero y notificar.

## 6. Anti‑suplantación y anti‑extorsión
Bandera «cuenta comprometida» de 72 h firmada (ECDSA del servidor), webhooks `identity.compromised` y `loan.block_requested`, mensaje predefinido a contactos de confianza. **Límite**: Meta/X/WhatsApp y las centrales de riesgo deben adherirse a la API; el MVP documenta y expone el contrato (`GET /v1/risk-flags/{userRef}`) pero no controla a terceros.

## 7. Google Pay / Apple Pay
* Google: Tap and Pay/HCE con DPAN; exige refrescar tokens con red → el MVP precarga tokens con TTL extendido (168 h) y lo documenta en la respuesta (`limitations`).
* Apple: no permite pagos offline puros; el flujo offline usa el vault propio de SafeWallet.
* **Wallet Guard** intercepta cada pago (SafeWallet/Google/Apple) y lo valida contra Escudo, integridad, límites y anomalía de comportamiento antes de liberar token/criptograma.
* **Límite**: aprovisionar a Google/Apple Wallet reales requiere ser emisor/TSP certificado y entitlements; aquí es simulación.

## 8. Anti‑reversa y anti‑clonación
* **Ofuscación**: Android con R8 (`isMinifyEnabled`, `proguard-rules.pro`) + Dart `--obfuscate --split-debug-info`; iOS con `--obfuscate` y strip de símbolos. Comando: `scripts/build-release.sh`.
* **Detección**: emulador, root/Magisk, Frida (puerto 27042 y librerías en `/proc/self/maps`), Xposed/LSPosed/Substrate, modo debug, firma del APK (requiere sonda nativa; en producción `requireSignature=true` ⇒ no poder verificar = no confiable).
* **Integridad en runtime**: ledger con HMAC encadenado + hash chain; WAL con AEAD + AAD de índice.
* **Servidor de confianza**: licencia por dispositivo (30 días, certificado firmado por el servidor), `device-id` = SHA‑256(clave pública), revocación remota, build registry (`/v1/admin/builds`), **watermark** `SW_BUILD_ID` por build.
* **Detección de clonación**: mismo device‑id en IPs distintas y geos > 100 km en 15 min ⇒ `blocked`.
* **Límite**: un atacante con dispositivo rooteado y tiempo puede evadir detecciones del lado cliente. La defensa que no depende del cliente es el servidor (attestation, contadores, revocación) y el hardware (SE).
* **Licencia** (`LICENSE`): prohíbe ingeniería inversa, extracción de modelos, entrenamiento de IA y clonación. Es disuasión legal, no técnica.

## 9. Otras defensas (punto 12)
Biometría continua (cadencia de tecleo, z‑score), límite por geolocalización/país, lista blanca de comercios, PIN de coacción, rotación 24 h/por riesgo, rate limiting por plan + anti fuerza bruta con Redis, canal de denuncia cifrado con cadena de custodia (`/v1/forensic`), botón de pánico silencioso (SMS con ubicación), testamento digital.
**Watermark de pantalla / bloqueo de capturas**: requiere `FLAG_SECURE` (Android) y overlays nativos; **no incluido** en el MVP (la app Flutter no los activa todavía).

## 10. Manejo de errores y secretos
* Ningún error se traga: el backend responde `{error:{code,message}}` y registra con contexto (pino, con redacción de `x-api-key`, `pin`, `pan`); la app muestra cada fallo en su registro de actividad.
* Sin secretos en el repositorio: `.env`/`*_FILE`; en desarrollo el *secret manager mock* genera `secrets.json` (0600) la primera vez; en `NODE_ENV=production` los secretos son **obligatorios** y el servidor no arranca sin ellos.
* Webhooks salientes firmados (`HMAC‑SHA256(ts.body)`), con bloqueo SSRF de destinos privados cuando `WEBHOOK_ALLOW_PRIVATE=false` (producción).
