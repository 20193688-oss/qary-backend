# Modelo de negocio B2B (fintechs pagan por la capa de seguridad)

| Plan | Incluye | Precio (referencial, USD/mes) | Funciones de API | Rate limit |
|---|---|---|---|---|
| **Starter** | SDK de tokenización + attestation | **499** | `tokenize`, `attest`, `rates` | 120/min |
| **Pro** | SDK + Protocolo Escudo + doble agente | **2 499** | + `authorize`, `reconcile`, `panic`, `qr`, `sms`, `reports`, `forensic`, `webhooks`, `risk` | 600/min |
| **Enterprise** | SDK + backend on‑prem + auditoría forense + SLA | a medida | todo + `on_prem`, `sla` | 6 000/min |

Los precios son hipótesis para validar con clientes piloto; los límites de plan están **aplicados en código** (`403 plan_required`, `429 rate_limited`) —
ver `GET /v1/plans`. Un plan inferior no puede invocar funciones Pro (probado).

## APIs expuestas
`/v1/tokenize` · `/v1/authorize-offline` · `/v1/reconcile` · `/v1/panic` · `/v1/attest` · `/v1/webhooks/fraud` (+ `/v1/webhooks/subscriptions`).
Contrato: `docs/openapi.json` (OpenAPI 3.1, generado desde las rutas reales y verificado por test).

## Sandbox público
`docker compose up` → clave `sw_sandbox_demo_key` (plan Pro, `fund` habilitado, MOCK de attestation/pasarela, sin datos reales). En producción `fund` y el mock de attestation se deshabilitan.

## Propiedad intelectual
* **Marca**: registrar nombre y logotipo en INDECOPI (Perú) y, según mercados, Madrid Protocol.
* **Patente**: solicitar patente de invención (INDECOPI) y vía **PCT** para el *método* de «doble agente offline‑online con conciliación diferida y Protocolo Escudo» (reivindicaciones sobre el método y el sistema, no sobre «software» en abstracto). Consultar a un abogado de PI **antes de divulgar** públicamente (la divulgación previa puede invalidar la novedad).
* **Código fuente**: depósito con sello de tiempo notarial o hash anclado; registro de derecho de autor en INDECOPI.
* **Secreto industrial + NDA**: documentación de seguridad y vectores bajo NDA con cada cliente.
* **Licencia dual (open core + comercial)**: núcleo criptográfico no diferencial puede liberarse (MIT/Apache‑2.0) para auditoría; el Protocolo Escudo, el doble agente y la conciliación permanecen propietarios (`LICENSE`).

## Requisitos de cumplimiento antes de producción
PCI‑DSS (si se tocan PAN reales), certificación EMVCo/red de pagos para DPAN, acuerdo con pasarelas, ley peruana de protección de datos (Ley 29733), evaluación de SBS para billeteras electrónicas.
