# Security baseline (PR 1 — completo en PR 12)

## No-go list (rechazo automático en review)

- Cualquier commit con `STRIPE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `JWT_SECRET` u otra credencial real.
- PAN, CVV o `card.number` persistido fuera de Stripe.
- Llamadas a LLM sin rate-limit por user.
- Endpoints de pago sin verificación de webhook signature.
- WebRTC con TURN sin auth.

## Voz + pagos

Antes de ejecutar `confirm_payment` por intent de voz:

1. Voice-liveness check (challenge dinámico, ej. repetir 3 dígitos aleatorios).
2. PIN numérico de 4 dígitos hash-bcrypt en backend.
3. Doble confirmación auditiva ("¿Confirmas $X a Y?").

## Retention

- `EVIDENCE_RETENTION_DAYS` (default 180) — media de incidentes/evidencias.
- `AUDIT_LOG_RETENTION_DAYS` (default 365) — tabla `events`.

## Pendiente PR 12

- WAF rules, SAST/DAST en CI bloqueante, SIEM JSON, playbooks IR, CODEOWNERS para `backend/payments/**` y `agents/**`, plan PCI.
