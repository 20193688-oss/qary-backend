#!/usr/bin/env node
// Simula N conductores random-walk y empuja al backend, que difunde por Socket.IO.
// Usage:
//   node scripts/simulate_drivers.js --count 8 [--api http://localhost:3000]
//                                    [--interval 1500] [--center -12.046,-77.030]
//
// Cada driver tiene un vehicleType del catálogo QARY (std/cf/ex/lx/xl/moto/bike/mudanzas)
// para que el filtro de transporte en la UI muestre solo los del tipo seleccionado.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const COUNT = Number(args.count ?? 6);
const API = args.api ?? process.env.API_BASE_URL ?? 'http://localhost:3000';
const INTERVAL = Number(args.interval ?? 1500);
const [centerLat, centerLng] = (args.center ?? '-12.046,-77.030').split(',').map(Number);

const TYPES = ['std', 'cf', 'ex', 'lx', 'xl', 'moto', 'bike', 'mudanzas'];
const TYPE_SPEED = { std: 28, cf: 28, ex: 30, lx: 30, xl: 24, moto: 38, bike: 18, mudanzas: 22 };

function rand(a, b) { return a + Math.random() * (b - a); }
function jitter(v, scale) { return v + (Math.random() - 0.5) * scale; }

const drivers = Array.from({ length: COUNT }, (_, i) => {
  const type = TYPES[i % TYPES.length];
  return {
    driverId: `sim-${type}-${i + 1}`,
    vehicleType: type,
    lat: jitter(centerLat, 0.018),
    lng: jitter(centerLng, 0.018),
    heading: rand(0, 360),
    speedKmh: TYPE_SPEED[type] ?? 25,
    available: true,
  };
});

console.log(`[sim] ${COUNT} drivers → ${API}/api/locations every ${INTERVAL}ms (types: ${TYPES.join(', ')})`);

async function tick() {
  await Promise.all(drivers.map(async (d) => {
    // simple random walk con heading suavizado
    d.heading = (d.heading + rand(-25, 25) + 360) % 360;
    const rad = (d.heading * Math.PI) / 180;
    const stepDeg = (d.speedKmh / 3600) * (INTERVAL / 1000) / 111; // ~grados por step
    d.lat += stepDeg * Math.cos(rad);
    d.lng += stepDeg * Math.sin(rad);
    try {
      const res = await fetch(`${API}/api/locations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          driverId: d.driverId,
          lat: d.lat,
          lng: d.lng,
          heading: d.heading,
          speedKmh: d.speedKmh,
          vehicleType: d.vehicleType,
          available: d.available,
          ts: Date.now(),
        }),
      });
      if (!res.ok) console.warn(`[sim] ${d.driverId} → ${res.status}`);
    } catch (e) {
      console.warn(`[sim] ${d.driverId} error:`, e.message);
    }
  }));
}

setInterval(tick, INTERVAL);
tick();
