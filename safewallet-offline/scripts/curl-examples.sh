#!/usr/bin/env bash
# Recorrido con cURL de TODOS los endpoints /v1/* sobre un dispositivo "sandbox".
# Los pasos que exigen firmas ECDSA del dispositivo usan el helper Node `scripts/sign.mjs`.
# Uso: BASE_URL=http://localhost:3000 scripts/curl-examples.sh
set -euo pipefail
cd "$(dirname "$0")"
BASE_URL="${BASE_URL:-http://localhost:3000}"
KEY="${API_KEY:-sw_sandbox_demo_key}"
ADMIN="${ADMIN_API_KEY:-sw_admin_demo_key}"
H=(-H "x-api-key: $KEY" -H 'content-type: application/json')
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }
pj() { python3 -c "import json,sys; print('\n'.join(json.dumps(json.load(sys.stdin),indent=1,ensure_ascii=False).splitlines()[:$1]))"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "GET /health y /v1/plans (públicos)"
curl -fsS "$BASE_URL/health"; echo
curl -fsS "$BASE_URL/v1/plans" | pj 20

step "GET /v1/rates — snapshot firmado para precargar offline"
curl -fsS "${H[@]}" "$BASE_URL/v1/rates" | pj 14

step "Dispositivo sandbox: genera claves y hace la attestation (GET /v1/attest/challenge + POST /v1/attest)"
DEV=$(node sign.mjs new)                         # {"publicKey": "...", "privateKeyPem": "..."} en un archivo temporal
CH=$(curl -fsS "${H[@]}" "$BASE_URL/v1/attest/challenge" | j "['challenge']")
ATT=$(node sign.mjs attest "$DEV" "$CH")
RESP=$(curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/attest" -d "$ATT")
ID=$(echo "$RESP" | j "['deviceId']"); echo "deviceId=$ID trusted=$(echo "$RESP" | j "['trusted']")"

step "PUT /v1/devices/{id}/profile — PIN, PIN de coacción, contactos, zona segura, límites"
curl -fsS -X PUT "${H[@]}" "$BASE_URL/v1/devices/$ID/profile" -d '{"phone":"+51999000'$RANDOM'","pin":"1234","duressPin":"4321","email":"yo@example.com","trustedContacts":[{"name":"Mamá","phone":"+51999111000"}],"safeZone":{"lat":-12.0464,"lon":-77.0428,"radiusM":5000},"deadmanHours":48}' | pj 8

step "POST /v1/devices/{id}/fund (sandbox) y GET /wallet"
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/devices/$ID/fund" -d '{"currency":"PEN","amountMinor":100000}'; echo
curl -fsS "${H[@]}" "$BASE_URL/v1/devices/$ID/wallet"; echo

step "POST /v1/tokenize — lote de DPAN de un solo uso (el PAN no se almacena)"
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/tokenize" -d '{"deviceId":"'$ID'","pan":"4111111111111111","expMonth":12,"expYear":2030,"currency":"PEN","count":5}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("cardRef",d["cardRef"],"tokens",len(d["tokens"]))'

step "POST /v1/wallets/provision — Google Pay / Apple Pay (simulado)"
CARD=$(curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/tokenize" -d '{"deviceId":"'$ID'","pan":"5555555555554444","expMonth":12,"expYear":2030,"currency":"PEN","count":2}' | j "['cardRef']")
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/wallets/provision" -d '{"deviceId":"'$ID'","wallet":"google_pay","cardRef":"'$CARD'"}' | pj 12

step "POST /v1/qr/dynamic, /v1/qr/verify, GET /v1/qr/{id}"
Q=$(curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/qr/dynamic" -d '{"deviceId":"'$ID'","amountMinor":1200,"currency":"USD"}')
QR=$(echo "$Q" | j "['qr']"); QID=$(echo "$Q" | j "['qrId']")
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/qr/verify" -d "{\"qr\":\"$QR\"}" | python3 -c 'import json,sys; print("valid:", json.load(sys.stdin)["valid"])'
curl -fsS "${H[@]}" "$BASE_URL/v1/qr/$QID"; echo

step "POST /v1/qr/emv/parse — QR EMVCo (Yape/Plin)"
EMV=$(node sign.mjs emv)
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/qr/emv/parse" -d "{\"payload\":\"$EMV\"}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["wallet"], d["merchantName"], d["currency"], d["amountMinor"])'

step "POST /v1/authorize-offline — voucher firmado (el replay de ledger /v1/reconcile se ejercita en los tests)"
node sign.mjs pay "$DEV" "$BASE_URL" "$KEY" "$ID"

step "POST /v1/devices/{id}/location (geofencing) y /checkin (testamento digital)"
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/devices/$ID/location" -d '{"lat":-12.05,"lon":-77.04,"biometricRecent":true}'; echo
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/devices/$ID/checkin" -d "$(node sign.mjs op "$DEV" checkin "$ID")"; echo

step "GET /v1/reports/{id}?period=daily — informe firmado"
curl -fsS "${H[@]}" "$BASE_URL/v1/reports/$ID?period=daily" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["period"], "hash", d["hash"][:16], "ops", d["txCount"])'

step "POST /v1/forensic/{id}/logs y GET /export — cadena de custodia"
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/forensic/$ID/logs" -d "$(node sign.mjs forensic "$DEV" "$ID" 'denuncia: robo en Av. Arequipa')" ; echo
curl -fsS "${H[@]}" "$BASE_URL/v1/forensic/$ID/export" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("deviceChainOk", d["deviceChainOk"], "anchorsOk", d["anchorsOk"])'

step "POST /v1/webhooks/subscriptions (y GET)"
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/webhooks/subscriptions" -d '{"url":"https://example.com/hook","events":["fraud.*","identity.compromised"]}'; echo
curl -fsS "${H[@]}" "$BASE_URL/v1/webhooks/subscriptions"; echo

step "POST /v1/panic — Protocolo Escudo (activación remota por PIN)"
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/panic" -d '{"deviceId":"'$ID'","trigger":"remote_web","pin":"1234"}' | pj 14

step "GET /v1/risk-flags/{userRef} — consulta de bancos / Meta / X / WhatsApp"
REF=$(curl -fsS -X PUT "${H[@]}" "$BASE_URL/v1/devices/$ID/profile" -d '{}' | j "['userRef']")
curl -fsS "${H[@]}" "$BASE_URL/v1/risk-flags/$REF" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("atRisk", d["atRisk"], "expira", d.get("expiresAt"))'

step "POST /v1/outbox/{id}/dispatch — SMS/email en cola (proveedor mock)"
curl -fsS -X POST "${H[@]}" "$BASE_URL/v1/outbox/$ID/dispatch" | python3 -c 'import json,sys; [print(m["kind"], m["to"], m["body"][:70]) for m in json.load(sys.stdin)["messages"]]'

step "Admin: POST /v1/rates, /v1/admin/builds, /v1/admin/sweep"
curl -fsS -X POST -H "x-api-key: $ADMIN" -H 'content-type: application/json' "$BASE_URL/v1/admin/builds" -d '{"buildId":"sandbox-build-1","appHash":"sandbox-app-hash"}'; echo
curl -fsS -X POST -H "x-api-key: $ADMIN" -H 'content-type: application/json' "$BASE_URL/v1/admin/sweep" -d '{}'; echo
echo; echo "OK — recorrido completo"
