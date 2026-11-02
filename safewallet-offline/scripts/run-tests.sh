#!/usr/bin/env bash
# Ejecuta TODA la batería: backend (memoria), backend contra PostgreSQL+Redis reales (si hay URLs),
# y la app Flutter incluyendo la integración real contra un backend levantado localmente.
#
#   scripts/run-tests.sh                       # backend en memoria + flutter (levanta un backend efímero en memoria)
#   TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://... scripts/run-tests.sh   # además contra servicios reales
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SW_TEST_PORT:-3099}"

echo "== backend: typecheck + tests (memoria) =="
(cd "$ROOT/backend" && npm ci --no-audit --no-fund >/dev/null && npm run typecheck && env -u TEST_DATABASE_URL -u TEST_REDIS_URL npm test)

if [[ -n "${TEST_DATABASE_URL:-}" && -n "${TEST_REDIS_URL:-}" ]]; then
  echo "== backend: tests contra PostgreSQL + Redis reales =="
  (cd "$ROOT/backend" && npm run test:integration)
fi

if command -v flutter >/dev/null 2>&1; then
  echo "== backend efímero para la integración Dart =="
  (cd "$ROOT/backend" && exec env NODE_ENV=development PORT="$PORT" SECRETS_FILE="$(mktemp -u)" LOG_LEVEL=error \
     ${TEST_DATABASE_URL:+DATABASE_URL="$TEST_DATABASE_URL"} ${TEST_REDIS_URL:+REDIS_URL="$TEST_REDIS_URL"} \
     node --import tsx src/index.ts) &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "el backend no arrancó"; exit 1; }
  echo "== app Flutter: analyze + tests (con integración real) =="
  (cd "$ROOT/mobile" && flutter pub get >/dev/null && flutter analyze && SW_BACKEND_URL="http://127.0.0.1:$PORT" flutter test)
else
  echo "(!) flutter no está instalado: se omiten las pruebas de la app móvil"
fi
echo "== TODO VERDE =="
