import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, '../../legacy/qary_superapp_v9.html');
const destDir = resolve(__dirname, '../public/legacy');
const dest = resolve(destDir, 'qary_superapp_v9.html');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[sync-legacy] ${src} -> ${dest}`);
