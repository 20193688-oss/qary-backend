import { buildApp } from './api/app.js';
import { createRuntime } from './runtime.js';
import { sweepDeadman } from './services/panic.js';
import { sweepReports } from './services/reports.js';

const { ctx, cfg } = await createRuntime();
const app = await buildApp(ctx);

const timer = setInterval(() => {
  void (async () => {
    try {
      const fired = await sweepDeadman(ctx);
      const reports = await sweepReports(ctx);
      if (fired.length || reports) ctx.log.info({ deadman: fired.length, reports }, 'barrido periódico');
    } catch (e) {
      ctx.log.error({ err: e }, 'barrido periódico falló');
    }
  })();
}, cfg.sweepIntervalMs);
timer.unref();

const shutdown = async (sig: string) => {
  ctx.log.info({ sig }, 'cerrando');
  clearInterval(timer);
  await app.close();
  await ctx.flush();
  await ctx.store.close();
  await ctx.kv.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: cfg.port, host: cfg.host });
