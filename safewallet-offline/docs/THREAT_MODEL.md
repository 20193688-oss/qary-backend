# Modelo de amenazas (STRIDE resumido)

Activos: dinero del usuario, claves del Secure Element, ledger offline, identidad en redes sociales, datos forenses.
Adversarios: A1 ladrón armado con el teléfono desbloqueado y biometría comprometida (caso real del documento); A2 estafador remoto
que suplanta al usuario ante contactos y bancos; A3 comerciante/cliente malicioso offline (doble gasto, tasa manipulada);
A4 atacante de red (MITM, replay); A5 reversador/clonador de la app; A6 insider/servidor comprometido.

| # | Amenaza | Vector | Mitigación en el producto | Riesgo residual |
|---|---|---|---|---|
| T1 | Vaciar cuentas con el celular desbloqueado | Apps bancarias, billetera | Billetera con límites offline y por operación; riesgo >70 exige PIN+biometría+SMS; PIN de coacción; Escudo < 3 s | El ladrón actúa antes de que la víctima reaccione; el daño se acota al límite diario |
| T2 | Préstamos interbancarios fraudulentos | Suplantación | Bandera de riesgo firmada 72 h + `loan.block_requested` a bancos/centrales aliados | Bancos no aliados ignoran la bandera |
| T3 | Suplantación en WhatsApp/FB/X/IG | Cuenta tomada | `identity.compromised` + `GET /v1/risk-flags` firmado | Requiere adhesión de las plataformas |
| T4 | Extorsión a contactos | SMS/llamadas | Mensaje firmado predefinido a contactos; alerta silenciosa con ubicación | No detiene llamadas de terceros |
| T5 | Desactivar GPS / bloquear denuncias | Atacante físico | Escudo funciona sin GPS ni datos; pánico firmado en cola; SMS con crédito del chip | Si apagan el equipo, el borrado local espera a la red |
| T6 | Doble gasto offline | Cliente clona estado | Token de un solo uso, contador monotónico, `insert` atómico, bloqueo preventivo | Gasto simultáneo ≤ límite antes de conciliar |
| T7 | Manipular el ledger | Edición del WAL | AEAD+AAD, hash chain, HMAC, ECDSA; rechazo y bloqueo | — |
| T8 | Replay / MITM en BLE‑NFC | Radio | Certificados firmados por el servidor, ECDH efímero, double ratchet, framing con CRC | Relay de radio en vivo (requiere distancia/ UWB, fuera de alcance) |
| T9 | Manipular tasa/precio | Voucher | Precio determinista verificable con snapshot firmado; `rate_tampering` ⇒ bloqueo | Tasa vieja dentro de 24 h de gracia |
| T10 | QR falso | Estafa | Firma del servidor verificable offline, expiración, un solo uso, monto/moneda ligados | QR EMVCo ajeno: sólo CRC/estructura; se confía en la pasarela |
| T11 | Fuerza bruta de PIN | SMS SOS / unlock | 5 fallos/15 min (Redis y WAL), scrypt/PBKDF2 | PIN corto de 4 dígitos sigue siendo débil sin límite de intentos |
| T12 | Ingeniería inversa / clonación | APK/IPA | Ofuscación R8/Dart, detección Frida/root/emulador, attestation, licencia por dispositivo, watermark | Evasión local posible; el servidor sigue siendo la barrera |
| T13 | Fuga de PAN | Backend | PAN nunca almacenado; logs redactados | Tránsito TLS obligatorio (proxy/ingress) |
| T14 | SSRF vía webhooks | Suscripciones | Bloqueo de IP privadas en producción | — |
| T15 | Servidor comprometido | Insider | Claves derivadas de secreto maestro (HSM/KMS recomendado), logs firmados | Sin anclaje externo el log puede reescribirse |
| T16 | Cross‑tenant | API | Aislamiento por `tenantId` en cada recurso | — |
| T17 | DoS | API | Rate limit por plan, bodyLimit 1 MB, validación JSON‑Schema | Falta WAF/CDN |

Fuera de alcance: coerción física para revelar el PIN real (mitigado parcialmente por el PIN de coacción), malware con acceso al SE
de hardware, ataques de canal lateral, compromiso de las claves de Google/Apple.
