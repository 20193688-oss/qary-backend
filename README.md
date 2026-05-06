# QARY Super-App

Super-app de movilidad / delivery / servicios estilo Uber + Rappi + InDrive con pagos, voz, agentes IA, mapa en tiempo real, llamadas WebRTC, control de hardware (linterna, mic, location bg) y evidencias.

> Branch de desarrollo: `claude/super-app-scaffold-gMX6q`. PRs atómicos por fase (ver `AUDIT.md`).

## Estructura

```
qary-backend/
├── frontend/   # React + Vite + Tailwind + PWA
├── backend/    # Node 20 + TS + Fastify + Prisma + Postgres + Redis + Socket.IO
├── agents/     # Microservicio IA (intents, STT/TTS, safety)
├── mobile/     # Expo + WebView v1
├── infra/      # docker-compose, terraform mínimo
├── scripts/    # simulate_drivers.js, simulate_calls.js, simulate_incident.js
└── legacy/     # qary_superapp_v9.html (HTML SPA original como referencia)
```

## Quick start (local)

```bash
# 1. dependencias
pnpm install

# 2. servicios (postgres, redis, minio, mailhog, coturn)
docker compose -f infra/docker-compose.yml up -d

# 3. db
pnpm --filter backend migrate
pnpm --filter backend seed

# 4. dev (paralelo)
pnpm dev          # frontend + backend
# o por separado
pnpm --filter frontend dev   # http://localhost:5173
pnpm --filter backend dev    # http://localhost:3000

# 5. mobile (Expo)
cd mobile && pnpm start      # escanea el QR
```

## Demo end-to-end (próximas fases)

```bash
# 5 conductores simulados moviéndose en el mapa
node scripts/simulate_drivers.js --count 5

# llamada WebRTC user↔driver
node scripts/simulate_calls.js --orderId <id>

# incidente con foto + transcripción
node scripts/simulate_incident.js --orderId <id>
```

## Configuración

Copia `.env.example` a `.env` y rellena keys (Stripe sandbox, Mapbox, Twilio sandbox, etc.). Nunca commitear `.env`.

## Defaults asumidos

- **Frontend**: React 18 + Vite + Tailwind + PWA
- **Backend**: Fastify + TS + Prisma + Postgres + Redis
- **Maps**: Mapbox GL (fallback Leaflet)
- **LLM**: Claude API (`claude-haiku-4-5`)
- **Mobile**: Expo + WebView v1, migración progresiva a RN nativo
- **Hosting staging**: Vercel (frontend) + Railway/Fly (backend)

## Estado de fases

- [x] PR 1 — Auditoría + import legacy + scaffold base de docs
- [ ] PR 2 — Scaffold monorepo
- [ ] PR 3 — Auth + pagos
- [ ] PR 4 — Mapa real-time
- [ ] PR 5 — WebRTC
- [ ] PR 6 — Voz + agentes
- [ ] PR 7 — Recording + evidencias
- [ ] PR 8 — Incidentes + receipts + audit
- [ ] PR 9 — Hardware nativo
- [ ] PR 10 — Tests + CI/CD
- [ ] PR 11 — Builds (APK/Expo/PWA)
- [ ] PR 12 — Seguridad final + entrega

## Seguridad

Ver `SECURITY.md` (PR 12). Reglas inmediatas:

- Nunca commitear secrets: solo `.env.example`.
- PAN/CVV jamás se guarda en el backend ni en localStorage; solo Stripe tokens.
- Confirmación PIN/voz antes de cualquier `confirm_payment`.
- Signed URLs (TTL ≤ 1h) para toda media.
- Audit log con `request_id` por cada acción sensible.
