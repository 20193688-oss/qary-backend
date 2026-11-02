# API REST `/v1/*`

Especificación completa **OpenAPI 3.1**: [`openapi.json`](openapi.json) (también en `GET /openapi.json`). Generada desde las mismas definiciones que validan las
peticiones, y verificada por un test de contrato (`npm test` falla si el archivo se desincroniza: `npm run openapi` lo regenera).

## Convenciones
* **Autenticación**: header `x-api-key`. Sandbox: `sw_sandbox_demo_key` (plan Pro). Admin: `sw_admin_demo_key` (solo desarrollo).
* **Errores**: `{"error":{"code":"...","message":"...","details":...}}` con HTTP 400/401/403/404/409/429/500. Los errores 500 nunca exponen internals.
* **Dinero**: enteros en unidades menores (`amountMinor`); **tasas**: enteros ×1e6 (`rateMicros`); **tiempos**: epoch ms. Sin números de punto flotante en objetos firmados.
* **Firmas**: ECDSA P‑256/SHA‑256 en formato IEEE P1363 (r‖s, 64 bytes) base64url; clave pública = punto sin comprimir `0x04‖X‖Y` base64url.
  Lo que se firma es el **JSON canónico** (claves ordenadas, sin espacios, solo enteros) — ver `canonical.ts` / `canonical.dart`.
* **Planes**: `403 plan_required` si el plan no incluye la función; `429 rate_limited` al exceder el límite por minuto.

## Endpoints
| Tag | Método | Ruta | Descripción | Plan/feature |
|---|---|---|---|---|
| admin | `POST` | `/v1/admin/builds` | Admin: registra un build legítimo (watermark de build + hash de app esperado) | admin |
| admin | `POST` | `/v1/admin/sweep` | Admin: ejecuta barridos (testamento digital, informes vencidos) | admin |
| attest | `GET` | `/v1/attest/challenge` | Obtiene un challenge de un solo uso para la attestation | attest |
| attest | `POST` | `/v1/attest` | Registra/valida un dispositivo (attestation + licencia por dispositivo) | attest |
| business | `GET` | `/v1/plans` | Planes SaaS B2B | público |
| devices | `GET` | `/v1/devices/{deviceId}` | Estado del dispositivo y comandos pendientes | attest |
| devices | `POST` | `/v1/devices/{deviceId}/commands/ack` | El dispositivo confirma comandos ejecutados (p. ej. SE_WIPE) | panic |
| devices | `POST` | `/v1/devices/{deviceId}/keys/rotate` | Rota las claves simétricas del dispositivo (24 h o por evento de riesgo) | attest |
| devices | `PUT` | `/v1/devices/{deviceId}/profile` | Configura PIN, PIN de coacción, contactos de confianza, zona segura y límites | attest |
| forensic | `GET` | `/v1/devices/{deviceId}/audit` | Log de auditoría append-only del dispositivo (verificable) | forensic |
| forensic | `GET` | `/v1/forensic/{deviceId}/export` | Exporta paquete de evidencia verificado (para comisaría/fiscalía) | forensic |
| forensic | `POST` | `/v1/forensic/{deviceId}/logs` | Sube logs/denuncias cifrados con cadena de custodia (hash chain) | forensic |
| ops | `GET` | `/health` | Estado del servicio | público |
| panic | `GET` | `/v1/risk-flags/{userRef}` | Estado firmado de riesgo de suplantación (bancos, centrales de riesgo, Meta/X/WhatsApp) | risk |
| panic | `POST` | `/v1/devices/{deviceId}/checkin` | Prueba de vida (testamento digital) | panic |
| panic | `POST` | `/v1/devices/{deviceId}/location` | Geofencing de riesgo + detección de clonación (misma identidad en IP/geo distintas) | panic |
| panic | `POST` | `/v1/devices/{deviceId}/unlock` | Reactiva un dispositivo bloqueado preventivamente (PIN real) | panic |
| panic | `POST` | `/v1/panic` | Activa el Protocolo Escudo (botón, PIN de coacción, SMS o web remota) | panic |
| payments | `POST` | `/v1/authorize-offline` | Autoriza y liquida un voucher de pago offline (comercio con red) | authorize |
| payments | `POST` | `/v1/reconcile` | Replay del ledger/WAL offline: cadena hash+MAC+firma, anti doble gasto, ajuste FX | reconcile |
| qr | `GET` | `/v1/qr/{qrId}` | Estado de pago de un QR dinámico | qr |
| qr | `POST` | `/v1/qr/dynamic` | Genera un QR dinámico firmado (monto, moneda, snapshot de tasas, DPAN) | qr |
| qr | `POST` | `/v1/qr/emv/parse` | Interoperabilidad: reconoce y valida un QR EMVCo (Yape/Plin/otros) | qr |
| qr | `POST` | `/v1/qr/emv/route` | Enruta un voucher firmado hacia la pasarela de la billetera destino (mock en MVP) | qr |
| qr | `POST` | `/v1/qr/verify` | Verifica un QR dinámico (firma del servidor, vigencia, tasas) | qr |
| rates | `GET` | `/v1/rates` | Snapshot de tasas firmado por el servidor (precarga offline) | rates |
| rates | `POST` | `/v1/rates` | Admin: publica un snapshot de tasas (o refresca desde fuentes BCE/referencia) | admin |
| reports | `GET` | `/v1/reports/{deviceId}` | Informe firmado (hourly|daily|weekly|monthly|yearly) anclado en log append-only | reports |
| sms | `POST` | `/v1/outbox/{deviceId}/dispatch` | Proveedor SMS/email (mock): entrega y marca como enviados los mensajes en cola | sms |
| sms | `POST` | `/v1/sms/inbound` | Gateway SMS: procesa SAFE-SOS-<PIN> y pagos cifrados SWPAY1 | sms |
| tokenization | `POST` | `/v1/tokenize` | Tokeniza una tarjeta: lote de DPAN de un solo uso + LUK envueltas para el dispositivo | tokenize |
| tokenization | `POST` | `/v1/tokens/revoke` | Revoca todos los tokens activos de una tarjeta | tokenize |
| tokenization | `POST` | `/v1/wallets/provision` | Aprovisiona la tarjeta tokenizada a Google Wallet / Apple Wallet (simulado) | tokenize |
| wallet | `GET` | `/v1/devices/{deviceId}/transactions` | Historial de transacciones liquidadas | attest |
| wallet | `GET` | `/v1/devices/{deviceId}/wallet` | Saldos de la billetera | attest |
| wallet | `POST` | `/v1/devices/{deviceId}/fund` | Sandbox: acredita saldo de prueba | attest |
| webhooks | `GET` | `/v1/webhooks/subscriptions` | Lista suscripciones de webhooks | webhooks |
| webhooks | `POST` | `/v1/webhooks/fraud` | Entrada: reporte de fraude de un aliado, firmado con HMAC (x-sw-timestamp, x-sw-signature) | webhooks |
| webhooks | `POST` | `/v1/webhooks/subscriptions` | Suscribe un endpoint a eventos de fraude (salida, firmados con HMAC) | webhooks |

## Objetos principales
**Voucher** (pago offline): `{ intent: {txId, payerDeviceId, payeeDeviceId|payeeRef, amountMinor, currency, payerAmountMinor, payerCurrency, rateMicros, marginBps, rateSnapshotId, token, arqc, counter, channel, ts, nonce, keyEpoch, geo?, stepUp?}, payerSig, payeeAck? }`.
`arqc = HMAC‑SHA256(LUK, canonical{token, amountMinor, currency, counter, txId})[0:32 hex]`.

**Entrada de ledger**: `{seq, counter, prevHash, keyEpoch, type, payload, hash, mac, sig}` con `hash = SHA‑256(canonical{seq,counter,prevHash,keyEpoch,type,payload})`,
`mac = HMAC(ledgerKey, hash)`, `sig = ECDSA(hash)`.

**Attestation** (`POST /v1/attest`): `statement` firmado por el dispositivo con el `challenge` de `GET /v1/attest/challenge`; la respuesta trae `certificate` (firmado por el servidor),
`keys` (ledger/SMS envueltos con ECIES para el dispositivo) y el snapshot de tasas.

**Webhooks de salida**: cabeceras `x-sw-timestamp`, `x-sw-signature: v1=HMAC‑SHA256(secret, ts + "." + body)`, `x-sw-event`. Eventos: `payment.settled`, `fraud.double_spend|counter_reuse|token_reuse|rate_tampering|limit_exceeded|ledger_tampered|geofence_breach|shield_activated`, `device.untrusted`, `device.clone_suspected`, `identity.compromised`, `loan.block_requested`.
**Webhook de entrada** `POST /v1/webhooks/fraud`: mismo esquema de firma con el `webhookSecret` del cliente; ventana de 5 min.

## Ejemplos cURL
`scripts/curl-examples.sh` recorre **todos** los endpoints (attestation firmada, tokenización, QR, EMV, pago real firmado, Escudo, riesgo, forense, webhooks, admin):

```bash
docker compose up -d --build
BASE_URL=http://localhost:3000 scripts/curl-examples.sh
```

Ejemplos sueltos:

```bash
H='x-api-key: sw_sandbox_demo_key'; B=http://localhost:3000
curl -s $B/v1/plans
curl -s -H "$H" $B/v1/rates                                                  # snapshot firmado para precargar
curl -s -H "$H" $B/v1/attest/challenge
curl -s -X POST -H "$H" -H 'content-type: application/json' $B/v1/tokenize \
  -d '{"deviceId":"<id>","pan":"4111111111111111","expMonth":12,"expYear":2030,"currency":"PEN","count":10}'
curl -s -X POST -H "$H" -H 'content-type: application/json' $B/v1/panic \
  -d '{"deviceId":"<id>","trigger":"remote_web","pin":"1234"}'
curl -s -H "$H" $B/v1/risk-flags/<userRef>
curl -s -X POST -H "$H" -H 'content-type: application/json' $B/v1/sms/inbound \
  -d '{"from":"+51911111111","to":"+51999000111","body":"SAFE-SOS-1234"}'
```
