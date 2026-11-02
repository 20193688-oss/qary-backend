#!/usr/bin/env bash
# Compila la app con ofuscación (Dart --obfuscate + R8 en Android), símbolos separados y marca de agua de build.
# Requiere Flutter + Android SDK / Xcode (NO disponibles en el entorno de CI de este repositorio: no se ejecutó aquí).
set -euo pipefail
cd "$(dirname "$0")/../mobile"
BUILD_ID="${SW_BUILD_ID:-sw-$(date -u +%Y%m%d%H%M)-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
APP_HASH="${SW_APP_HASH:-$(git rev-parse HEAD 2>/dev/null || echo local)}"
SYMS="${SW_SYMBOLS_DIR:-build/symbols}"
DEFINES=(--dart-define=SW_BUILD_ID="$BUILD_ID" --dart-define=SW_APP_HASH="$APP_HASH" --dart-define=SW_API_URL="${SW_API_URL:?define SW_API_URL}" --dart-define=SW_API_KEY="${SW_API_KEY:?define SW_API_KEY}")
echo "build watermark: $BUILD_ID"
flutter pub get
flutter build apk --release --obfuscate --split-debug-info="$SYMS" "${DEFINES[@]}"
flutter build appbundle --release --obfuscate --split-debug-info="$SYMS" "${DEFINES[@]}"
if [[ "$(uname)" == "Darwin" ]]; then
  flutter build ipa --release --obfuscate --split-debug-info="$SYMS" "${DEFINES[@]}"
fi
echo "Registra el build en el backend:  POST /v1/admin/builds {\"buildId\":\"$BUILD_ID\",\"appHash\":\"$APP_HASH\"}"
