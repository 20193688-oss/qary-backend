import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { StripeLike } from './lib/stripe.js';
import type { Realtime } from './lib/realtime.js';
import { noopRealtime } from './lib/realtime.js';
import { authPlugin } from './lib/auth-plugin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrdersRoutes } from './routes/orders.js';
import { registerLocationsRoutes } from './routes/locations.js';
import { registerIncidentsRoutes } from './routes/incidents.js';
import { registerPaymentsRoutes } from './routes/payments.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerReceiptsRoutes } from './routes/receipts.js';
import { registerVoicePaymentRoutes } from './routes/voice-payment.js';

export interface AppDeps {
  prisma: PrismaClient;
  redis: Redis;
  stripe: StripeLike;
  realtime?: Realtime;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const isTest = process.env.NODE_ENV === 'test';
  const app = Fastify({
    logger: isTest
      ? false
      : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: true,
    disableRequestLogging: isTest,
  });

  // Captura rawBody siempre — necesario para verificar firma Stripe.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as { rawBody?: Buffer }).rawBody = body as Buffer;
      try {
        const text = (body as Buffer).toString('utf8');
        done(null, text.length ? JSON.parse(text) : {});
      } catch (e) {
        done(e as Error);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: process.env.APP_BASE_URL ?? true, credentials: true });
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN ?? 120),
    timeWindow: '1 minute',
  });
  await authPlugin(app);

  await registerHealthRoutes(app);
  await registerAuthRoutes(app, deps);
  await registerOrdersRoutes(app);
  await registerLocationsRoutes(app, { realtime: deps.realtime ?? noopRealtime });
  await registerIncidentsRoutes(app);
  await registerPaymentsRoutes(app, deps);
  await registerWebhookRoutes(app, deps);
  await registerReceiptsRoutes(app, deps);
  await registerVoicePaymentRoutes(app, deps);

  return app;
}
