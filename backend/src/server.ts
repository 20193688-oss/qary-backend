import 'dotenv/config';
import { Server as SocketServer } from 'socket.io';
import { buildApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { getRedis } from './lib/redis.js';
import { getStripe } from './lib/stripe.js';
import type { StripeLike } from './lib/stripe.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  let stripe: StripeLike;
  try { stripe = getStripe(); }
  catch (e) {
    console.warn('[boot] Stripe disabled:', (e as Error).message);
    stripe = {} as StripeLike;
  }

  const app = await buildApp({
    prisma,
    redis: getRedis(),
    stripe,
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });

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
