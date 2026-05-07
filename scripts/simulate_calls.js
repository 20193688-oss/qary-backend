#!/usr/bin/env node
// Stub para PR 5: lanzará dos clientes WebRTC vs el signaling backend.
// Por ahora, sólo verifica que el endpoint /ws/signaling responde a ping.
// Usage: node scripts/simulate_calls.js --orderId xyz [--api http://localhost:3000]

import { WebSocket } from 'ws';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const orderId = args.orderId ?? 'demo-order';
const api = (args.api ?? 'http://localhost:3000').replace(/^http/, 'ws');

const ws = new WebSocket(`${api}/ws/signaling?orderId=${orderId}&peer=user`);
ws.on('open', () => {
  console.log('[sim-calls] connected. Sending stub offer.');
  ws.send(JSON.stringify({ type: 'offer', sdp: 'stub' }));
});
ws.on('message', (m) => console.log('[sim-calls] <-', m.toString()));
ws.on('error', (e) => console.error('[sim-calls] error:', e.message, '→ implementar /ws/signaling en PR 5'));
