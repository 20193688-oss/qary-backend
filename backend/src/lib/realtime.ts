// Hub realtime: emite eventos a Socket.IO. En tests se reemplaza por un mock.

export interface DriverPosition {
  driverId: string;
  lat: number;
  lng: number;
  heading?: number;
  speedKmh?: number;
  ts: number;
  vehicleType?: string; // std|cf|ex|lx|xl|moto|bike|mudanzas
  available?: boolean;
}

export interface Realtime {
  broadcastDriverPosition(p: DriverPosition): void;
  emitToOrder(orderId: string, event: string, payload: unknown): void;
}

// Implementación basada en Socket.IO. Se importa lazy para evitar circular imports.
export function createRealtime(io: import('socket.io').Server): Realtime {
  return {
    broadcastDriverPosition(p) {
      io.to('drivers:positions').emit('driver:position', p);
      if (p.vehicleType) io.to(`drivers:positions:${p.vehicleType}`).emit('driver:position', p);
    },
    emitToOrder(orderId, event, payload) {
      io.to(`order:${orderId}`).emit(event, payload);
    },
  };
}

export const noopRealtime: Realtime = {
  broadcastDriverPosition() {},
  emitToOrder() {},
};
