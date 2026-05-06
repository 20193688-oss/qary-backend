#!/usr/bin/env node
// Simula N conductores moviéndose (random walk) y empujando posiciones al backend.
// Usage: node scripts/simulate_drivers.js --count 5 [--api http://localhost:3000] [--interval 2000]

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const COUNT = Number(args.count ?? 3);
const API = args.api ?? process.env.API_BASE_URL ?? 'http://localhost:3000';
const INTERVAL = Number(args.interval ?? 2000);

// Lima centro como base
const BASE = { lat: -12.044, lng: -77.041 };

function jitter(v, scale = 0.0008) {
  return v + (Math.random() - 0.5) * scale;
}

const drivers = Array.from({ length: COUNT }, (_, i) => ({
  driverId: `sim-driver-${i + 1}`,
  lat: jitter(BASE.lat, 0.02),
  lng: jitter(BASE.lng, 0.02),
}));

console.log(`[sim] ${COUNT} drivers → ${API}/api/locations every ${INTERVAL}ms`);

async function tick() {
  for (const d of drivers) {
    d.lat = jitter(d.lat);
    d.lng = jitter(d.lng);
    try {
      const res = await fetch(`${API}/api/locations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ driverId: d.driverId, lat: d.lat, lng: d.lng, ts: Date.now() }),
      });
      if (!res.ok) console.warn(`[sim] ${d.driverId} → ${res.status}`);
    } catch (e) {
      console.warn(`[sim] ${d.driverId} error:`, e.message);
    }
  }
}

setInterval(tick, INTERVAL);
tick();
