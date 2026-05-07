// Copia legacy/qary_superapp_v9.html → mobile/android/app/src/main/assets/pwa/index.html
// e inyecta el overlay PR4 (qary_pr4_overlay.js) antes de </body>.
// El overlay añade transportes unificados, mapa real-time, TTS UI, API key, etc.

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const legacyHtml = resolve(__dirname, '../../legacy/qary_superapp_v9.html');
const overlayJs = resolve(__dirname, '../../legacy/qary_pr4_overlay.js');
const destDir = resolve(__dirname, '../android/app/src/main/assets/pwa');
const dest = resolve(destDir, 'index.html');

mkdirSync(destDir, { recursive: true });

const html = readFileSync(legacyHtml, 'utf8');
const overlay = readFileSync(overlayJs, 'utf8');

// Inserta el overlay como <script> inline justo antes de </body>.
const tag = '<script id="qary-pr4-overlay">\n' + overlay + '\n</script>\n';
const out = html.includes('</body>')
  ? html.replace('</body>', tag + '</body>')
  : html + '\n' + tag;

writeFileSync(dest, out, 'utf8');
const { size } = statSync(dest);
console.log(`[copy-legacy] ${legacyHtml} + overlay -> ${dest} (${(size / 1024).toFixed(1)} KiB)`);
