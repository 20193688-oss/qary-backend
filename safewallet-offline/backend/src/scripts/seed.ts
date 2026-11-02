/** Seed de sandbox: tenants demo, build legítimo y snapshot de tasas. Uso: npm run seed (o scripts/seed-rates.sh vía HTTP). */
import { createRuntime } from '../runtime.js';
import { REFERENCE_RATES_MICROS, publishRates } from '../services/rates.js';
import { registerBuild } from '../services/devices.js';

const { ctx } = await createRuntime();
const snap = await publishRates(ctx, REFERENCE_RATES_MICROS, 'seed-reference');
await registerBuild(ctx, 'sandbox-build-1', 'sandbox-app-hash');
ctx.log.info({ snapshot: snap.id }, 'seed completado');
await ctx.flush();
await ctx.store.close();
await ctx.kv.close();
