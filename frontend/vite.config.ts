import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'legacy.html'],
      manifest: {
        name: 'QARY Super-App',
        short_name: 'QARY',
        description: 'Movilidad, delivery y servicios con voz e IA',
        theme_color: '#0D0B2E',
        background_color: '#0D0B2E',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'mapbox-tiles' },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, host: true },
  preview: { port: 5173, host: true },
});
