#!/usr/bin/env node
// Crea un incidente de prueba.
// Usage: node scripts/simulate_incident.js [--orderId xxx] [--api http://localhost:3000]

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const API = args.api ?? 'http://localhost:3000';
const orderId = args.orderId;

const payload = {
  userId: 'demo-user-id',
  orderId,
  type: 'SAFETY',
  description: 'Conductor tomó una ruta desconocida. Solicito asistencia.',
  media: [],
};

const res = await fetch(`${API}/api/incidents`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
console.log(res.status, await res.json());
