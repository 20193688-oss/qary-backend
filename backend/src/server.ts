import 'dotenv/config';
import { Server as SocketServer } from 'socket.io';
import { buildApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { getRedis } from './lib/redis.js';
import { getStripe } from './lib/stripe.js';
import type { StripeLike } from './lib/stripe.js';
import { createRealtime } from './lib/realtime.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  let stripe: StripeLike;
  try { stripe = getStripe(); }
  catch (e) {
    console.warn('[boot] Stripe disabled:', (e as Error).message);
    stripe = {} as StripeLike;
  }

  // Stub temporal: realtime se inyecta tras crear el HTTP server.
  let realtime = (await import('./lib/realtime.js')).noopRealtime;
  const realtimeProxy = {
    broadcastDriverPosition: (p: Parameters<typeof realtime.broadcastDriverPosition>[0]) =>
      realtime.broadcastDriverPosition(p),
    emitToOrder: (...args: Parameters<typeof realtime.emitToOrder>) =>
      realtime.emitToOrder(...args),
  };

  const app = await buildApp({
    prisma,
    redis: getRedis(),
    stripe,
    realtime: realtimeProxy,
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });

  const io = new SocketServer(app.server, {
    cors: { origin: process.env.APP_BASE_URL ?? '*' },
    transports: ['websocket', 'polling'],
  });
  realtime = createRealtime(io);

  io.on('connection', (socket) => {
    app.log.info({ id: socket.id }, 'socket connected');
    socket.on('subscribe:order', (orderId: string) => socket.join(`order:${orderId}`));
    // Drivers feed: opcionalmente filtrado por tipo (std|moto|xl|...).
    socket.on('subscribe:drivers', (vehicleType?: string) => {
      socket.join('drivers:positions');
      if (vehicleType) socket.join(`drivers:positions:${vehicleType}`);
    });
    socket.on('unsubscribe:drivers', (vehicleType?: string) => {
      socket.leave('drivers:positions');
      if (vehicleType) socket.leave(`drivers:positions:${vehicleType}`);
    });
    socket.on('disconnect', () => app.log.info({ id: socket.id }, 'socket disconnected'));
  });

  app.log.info(`QARY backend listening on :${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
