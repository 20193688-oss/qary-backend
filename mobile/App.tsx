import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

// PWA URL resolution priority:
// 1. EXPO_PUBLIC_PWA_URL (configurable at build time, e.g. https://qary.vercel.app)
// 2. Bundled legacy HTML at file:///android_asset/pwa/index.html (Android)
//    o ./pwa/index.html para iOS (cargado desde el bundle).
//
// En el APK release standalone (sin Metro) usamos la opción 2: la SPA legacy
// embebida que NO depende de un backend para mostrar la demo visual.
const REMOTE_URL = process.env.EXPO_PUBLIC_PWA_URL?.trim();
const ANDROID_LOCAL = 'file:///android_asset/pwa/index.html';
const IOS_LOCAL = './pwa/index.html';

const SOURCE_URI = REMOTE_URL && REMOTE_URL.length > 0
  ? REMOTE_URL
  : Platform.OS === 'android' ? ANDROID_LOCAL : IOS_LOCAL;

export default function App() {
  const webRef = useRef<WebView>(null);

  useEffect(() => {
    (async () => {
      try {
        await Location.requestForegroundPermissionsAsync();
        await Notifications.requestPermissionsAsync();
      } catch {}
    })();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <WebView
        ref={webRef}
        source={{ uri: SOURCE_URI }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        geolocationEnabled
        // Permitir que el HTML embebido cargue assets relativos y haga fetch a HTTPS.
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        onMessage={(e) => {
          // bridge para comandos del agente IA (PR 6)
          // ej: { type: 'toggle_flash', on: true }
          console.log('PWA → native:', e.nativeEvent.data);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0B2E' },
});
