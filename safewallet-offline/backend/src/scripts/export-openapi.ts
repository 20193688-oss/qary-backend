/** Exporta la especificación OpenAPI 3.1 viva a docs/openapi.json (la prueba de contrato verifica que no se desincronice). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from '../api/openapi.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/openapi.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + '\n');
console.log('OpenAPI escrito en', out);
