// Copia legacy/qary_superapp_v9.html como mobile/android/app/src/main/assets/pwa/index.html
// para que el APK release lo sirva offline desde file:///android_asset/pwa/index.html.
// Sin esto el APK no tiene HTML que mostrar.

import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, '../../legacy/qary_superapp_v9.html');
const destDir = resolve(__dirname, '../android/app/src/main/assets/pwa');
const dest = resolve(destDir, 'index.html');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
const { size } = statSync(dest);
console.log(`[copy-legacy] ${src} -> ${dest} (${(size / 1024).toFixed(1)} KiB)`);
