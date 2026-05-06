import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

const PWA_URL = process.env.EXPO_PUBLIC_PWA_URL ?? 'http://10.0.2.2:5173';

// Wrapper v1: WebView a la PWA. Permisos nativos solicitados al entrar.
// PR 9 reemplazará pantallas críticas por componentes RN nativos (linterna, location bg).
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
        source={{ uri: PWA_URL }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        geolocationEnabled
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
