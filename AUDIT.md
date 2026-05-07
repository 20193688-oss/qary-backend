# Auditoría — `legacy/qary_superapp_v9.html`

Archivo único de 8002 líneas, SPA con 30+ pantallas. UI completa pero sin backend, sin auth real, sin pagos reales y con riesgos de seguridad (PAN en `localStorage`).

## Inventario de pantallas

| ID | Línea | Función | Migra a (ruta React) |
|----|-------|---------|----------------------|
| `s-splash` | 840 | Splash animado | `/` |
| `s-onboarding` | 858 | 3 pasos permisos (location, notif, cam) | `/onboarding` |
| `s-otp` | 877 | Verificación OTP 4 dígitos | `/auth/otp` |
| `s-home` | 897 | Hub de servicios | `/home` |
| `s-explore` | 1011 | Explorar comercios | `/explore` |
| `s-map` | 1093 | Mapa Leaflet + ride select | `/map` |
| `s-services` | 1128 | Catálogo de servicios | `/services` |
| `s-cart` | 1160 | Carrito | `/cart` |
| `s-checkout` | 1177 | Checkout | `/checkout` |
| `s-payment` | 1222 | Métodos de pago | `/payment` |
| `s-booking` | 1279 | Tracking de viaje + ETA | `/booking/:id` |
| `s-chat` | 1332 | Chat con conductor (foto/audio) | `/chat/:orderId` |
| `s-camera` | 1397 | Cámara + flash + video 15s | `/camera` |
| `s-profile` | 1424 | Perfil | `/profile` |
| `s-worker` | 1465 | Modo trabajador | `/worker` |
| `s-driver` | 1497 | Modo conductor | `/driver` |
| `s-login` / `s-register` / `s-forgot` | 1548-1595 | Auth | `/auth/*` |
| `s-edit-profile` / `s-my-places` | 1607-1640 | Settings | `/profile/*` |
| `s-premium` | 1692 | Suscripción | `/premium` |
| `s-soporte` | 1755 | Soporte | `/support` |
| `s-historial` | 1866 | Historial | `/history` |
| `s-recarga` | 1886 | Recarga saldo | `/wallet/topup` |
| `s-conductor-form` / `s-repartidor-form` / `s-empresa-form` | 1923-2001 | Onboarding partners | `/partners/*` |
| `s-ai-panel` | 2033 | Panel IA (stub) | `/ai` |
| `s-ofertas` | 2129 | Promociones | `/deals` |
| `s-bcp-transfer` | 2185 | Transferencia BCP | `/wallet/transfer` |

## APIs del navegador en uso

| API | Función legacy | Línea | Plan super-app |
|-----|----------------|-------|----------------|
| Leaflet | `initMap` | 2614 | Reemplazar por Mapbox GL, mantener fallback |
| `navigator.geolocation` | `getGeo`, `centerMap` | 2598-2645 | Backend recibe vía `POST /api/locations` + Socket.IO |
| `navigator.mediaDevices.getUserMedia` | `startCam` | 2942 | Reusar para evidencias |
| `MediaRecorder` (video) | `startRec` | 3004 | Pipe a SFU recording server |
| `applyConstraints({advanced:[{torch:true}]})` | `camFlash` | 2966 | Comando voz `toggle_flash` |
| `localStorage` para `qary_saved_cards` | `addCard` | 2856 | **ELIMINAR**: tokenizar con Stripe SetupIntent |
| `navigator.vibrate` | global | varias | Conservar |

## Riesgos detectados

| Severidad | Ítem | Línea | Mitigación |
|-----------|------|-------|------------|
| **Alta** | Tarjetas en `localStorage` (PAN parcial + datos titular) | 2856-2921 | Borrar storage, migrar a Stripe tokens |
| Alta | OTP simulado en cliente sin backend | 2582 | `/api/auth/otp/verify` con rate-limit |
| Alta | Sin CSP, mezcla `https://unpkg.com` | 8-9 | CSP estricta + bundle local |
| Media | Sin auth → cualquiera ve modo `driver` | `APP.role` 2323 | RBAC backend |
| Media | Sin telemetría ni audit log | — | Tabla `events` + `request_id` |
| Baja | Iconos emoji para estados críticos | varias | Mantener pero añadir aria-labels |

## Funcionalidades que CONSERVAR del HTML

1. Flow de onboarding (3 pasos con justificación de permiso) — copiar texts a React.
2. Animación de driver marker en el mapa (`startDriverMarkerAnimation` L.2633) — extender con interpolación `requestAnimationFrame`.
3. UX de cámara con grabación 15s + torch — base para evidencias.
4. Mini-cart deslizable — patrón replicable.
5. Toast + loading overlay — primitivos UI.
6. Naming de roles (`user` / `driver` / `worker`) — mantener en `Prisma.UserRole`.

## Estrategia de migración

- **Fase 0 (este PR):** legacy congelado en `legacy/qary_superapp_v9.html`, servido como fallback en `/legacy.html` desde el frontend para comparación visual.
- **Fase 1 (PR 2):** scaffold monorepo, frontend renderiza splash + onboarding nativos en React; resto de pantallas iframe-embeben legacy hasta migrarse.
- **Fases 2-12:** una pantalla legacy se elimina cada vez que su equivalente React+API entra en producción.
