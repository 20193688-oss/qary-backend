# mobile (Expo + WebView v1)

Wrapper rápido para tener APK/Expo Go funcionando en celular sin laptop adicional.

## Dev

```bash
cd mobile
pnpm install
EXPO_PUBLIC_PWA_URL=http://<tu-ip-LAN>:5173 pnpm start  # escanea QR
```

En emulador Android usa `http://10.0.2.2:5173`. En iOS Simulator `http://localhost:5173`.

## Build APK debug (sin laptop ajena)

```bash
pnpm build:apk        # eas build --platform android --profile preview --local
adb install ./qary-superapp.apk
```

## Permisos solicitados al inicio

- `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION`
- `CAMERA` + `RECORD_AUDIO` + `FLASHLIGHT`
- `POST_NOTIFICATIONS`

## Bridge PWA ↔ nativo (PR 6+)

`window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'toggle_flash', on: true }))` desde el agente de voz dispara acciones nativas en `App.tsx#onMessage`.
