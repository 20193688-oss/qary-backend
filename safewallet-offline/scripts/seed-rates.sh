#!/usr/bin/env bash
# Publica un snapshot de tasas firmado (referencia estática, base USD) usando la API de administración.
# Uso: BASE_URL=http://localhost:3000 ADMIN_API_KEY=sw_admin_demo_key scripts/seed-rates.sh [--refresh]
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_API_KEY="${ADMIN_API_KEY:-sw_admin_demo_key}"

if [[ "${1:-}" == "--refresh" ]]; then
  # intenta la fuente BCE y cae a las tasas de referencia si no hay red
  BODY='{"refresh":true}'
else
  # unidades de moneda por 1 USD, multiplicadas por 1e6
  BODY='{"source":"seed-reference","ratesMicros":{"USD":1000000,"PEN":3750000,"EUR":920000,"CRC":520000000,"VES":36500000,"COP":4000000000}}'
fi

curl -fsS -X POST "$BASE_URL/v1/rates" \
  -H "x-api-key: $ADMIN_API_KEY" -H 'content-type: application/json' -d "$BODY" \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); print("snapshot", s["id"], "fuente", s["source"], "vence", s["expiresAt"])'
