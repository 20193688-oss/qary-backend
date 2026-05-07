import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryPrisma, createInMemoryRedis, createMockStripe } from './_mocks.js';

describe('POST /api/locations', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    broadcast = vi.fn();
    app = await buildApp({
      prisma: createInMemoryPrisma(),
      redis: createInMemoryRedis(),
      stripe: createMockStripe() as never,
      realtime: {
        broadcastDriverPosition: broadcast,
        emitToOrder: vi.fn(),
      },
    });
    await app.ready();
  });

  it('valida y difunde posición de driver', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/locations',
      payload: {
        driverId: 'sim-moto-1', lat: -12.05, lng: -77.04,
        vehicleType: 'moto', heading: 180, speedKmh: 30, available: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const arg = broadcast.mock.calls[0]![0]!;
    expect(arg.driverId).toBe('sim-moto-1');
    expect(arg.vehicleType).toBe('moto');
    expect(typeof arg.ts).toBe('number');
  });

  it('rechaza coordenadas inválidas', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/locations',
      payload: { driverId: 'x', lat: 999, lng: 0 },
    });
    expect(res.statusCode).toBe(500); // Zod throw → Fastify 500 sin handler custom
    expect(broadcast).not.toHaveBeenCalled();
  });
});
