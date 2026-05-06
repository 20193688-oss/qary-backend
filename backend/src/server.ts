import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Server as SocketServer } from 'socket.io';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrdersRoutes } from './routes/orders.js';
import { registerLocationsRoutes } from './routes/locations.js';
import { registerIncidentsRoutes } from './routes/incidents.js';
import { logger } from './lib/logger.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  const app = Fastify({ logger: logger as any, trustProxy: true });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: process.env.APP_BASE_URL ?? true, credentials: true });
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN ?? 120),
    timeWindow: '1 minute',
  });

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerOrdersRoutes(app);
  await registerLocationsRoutes(app);
  await registerIncidentsRoutes(app);

  await app.listen({ port: PORT, host: '0.0.0.0' });

  // Socket.IO compartiendo el mismo HTTP server
  const io = new SocketServer(app.server, {
    cors: { origin: process.env.APP_BASE_URL ?? '*' },
    transports: ['websocket'],
  });
  io.on('connection', (socket) => {
    app.log.info({ id: socket.id }, 'socket connected');
    socket.on('subscribe:order', (orderId: string) => socket.join(`order:${orderId}`));
    socket.on('disconnect', () => app.log.info({ id: socket.id }, 'socket disconnected'));
  });

  app.log.info(`QARY backend listening on :${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
