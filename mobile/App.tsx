import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

const REMOTE_URL = process.env.EXPO_PUBLIC_PWA_URL?.trim();
const ANDROID_LOCAL = 'file:///android_asset/pwa/index.html';
const IOS_LOCAL = './pwa/index.html';

const SOURCE_URI = REMOTE_URL && REMOTE_URL.length > 0
  ? REMOTE_URL
  : Platform.OS === 'android' ? ANDROID_LOCAL : IOS_LOCAL;

// URLs que SÍ debe manejar la WebView en su propio frame.
const INTERNAL_PROTOCOLS = /^(file|about|data|blob|javascript|http|https):/i;
// Hosts que aunque sean https deben abrirse en la app nativa correspondiente.
const NATIVE_HTTPS_HOSTS = [
  'wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'whatsapp.com',
];

function shouldDispatchToOS(url: string): boolean {
  if (!url) return false;
  if (!INTERNAL_PROTOCOLS.test(url)) return true; // tel:, sms:, mailto:, intent:, qary://, etc.
  try {
    const u = new URL(url);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && NATIVE_HTTPS_HOSTS.includes(u.host)) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

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

  const handleNavigation = (req: WebViewNavigation): boolean => {
    if (shouldDispatchToOS(req.url)) {
      Linking.openURL(req.url).catch(() => {
        // tel:/sms:/mailto:/whatsapp sin app instalada: la PWA debe mostrar fallback.
        webRef.current?.injectJavaScript(`
          (function(){ try { (window.toast||console.log)('⚠️ App no disponible. URL: ${req.url.replace(/'/g, "\\'")}'); } catch(e){} true; })();
        `);
      });
      return false;
    }
    return true;
  };

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
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={handleNavigation}
        onMessage={(e) => {
          // Bridge para comandos del agente IA (PR 6).
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
