import type { Ctx, LogRecord } from '../ctx.js';
import { verifyLogChain } from '../ctx.js';
import { canonical } from '../util/canonical.js';
import { ecdsaVerify, GENESIS_HASH, sha256Hex } from '../util/crypto.js';
import { badRequest, conflict } from '../util/errors.js';
import type { Tenant } from '../types.js';
import { getDevice } from './devices.js';

export interface ForensicEntry { index: number; type: string; ts: number; ciphertext: string; prevHash: string; hash: string; sig: string; [k: string]: unknown }

export const forensicHash = (deviceId: string, e: Pick<ForensicEntry, 'index' | 'type' | 'ts' | 'ciphertext' | 'prevHash'>): string =>
  sha256Hex(canonical({ deviceId, index: e.index, type: e.type, ts: e.ts, ciphertext: e.ciphertext, prevHash: e.prevHash }));

/** Sube logs/denuncias cifrados del dispositivo. Verifica hash chain + firma del dispositivo y ancla la cabeza con sello del servidor. */
export async function uploadForensic(ctx: Ctx, tenant: Tenant, deviceId: string, entries: ForensicEntry[]) {
  const d = await getDevice(ctx, deviceId, tenant);
  return ctx.lock(`forensic:${d.id}`, async () => {
    const head = (await ctx.store.get<{ index: number; hash: string }>('forensic_heads', d.id)) ?? { index: -1, hash: GENESIS_HASH };
    let cur = head; let accepted = 0;
    for (const e of [...entries].sort((a, b) => a.index - b.index)) {
      if (e.hash !== forensicHash(d.id, e)) throw badRequest('forensic_hash_invalid', `hash inválido en índice ${e.index}`);
      if (e.index <= cur.index) {
        const prev = await ctx.store.get<ForensicEntry>(`forensic:${d.id}`, String(e.index).padStart(10, '0'));
        if (prev && prev.hash === e.hash) continue; // reenvío idempotente
        throw conflict('forensic_fork', `la entrada ${e.index} contradice la cadena ya anclada`);
      }
      if (e.index !== cur.index + 1 || e.prevHash !== cur.hash) throw badRequest('forensic_chain_broken', `cadena rota en índice ${e.index}`);
      if (e.hash !== forensicHash(d.id, e)) throw badRequest('forensic_hash_invalid', `hash inválido en índice ${e.index}`);
      if (!ecdsaVerify(d.publicKey, e.hash, e.sig)) throw badRequest('forensic_signature_invalid', `firma inválida en índice ${e.index}`);
      await ctx.store.put(`forensic:${d.id}`, String(e.index).padStart(10, '0'), e);
      cur = { index: e.index, hash: e.hash };
      accepted++;
    }
    if (accepted) {
      await ctx.store.put('forensic_heads', d.id, cur);
      await ctx.appendLog(`forensic:${d.id}`, 'anchor', { headIndex: cur.index, headHash: cur.hash, accepted });
    }
    return { deviceId: d.id, accepted, headIndex: cur.index, headHash: cur.hash };
  });
}

export async function exportForensic(ctx: Ctx, tenant: Tenant, deviceId: string) {
  const d = await getDevice(ctx, deviceId, tenant);
  const entries = (await ctx.store.list<ForensicEntry>(`forensic:${d.id}`, 100000)).sort((a, b) => a.index - b.index);
  const anchors = (await ctx.store.list<LogRecord>(`log:forensic:${d.id}`, 100000)).sort((a, b) => a.index - b.index);
  let prev = GENESIS_HASH; let deviceChainOk = true;
  for (const e of entries) {
    if (e.prevHash !== prev || e.hash !== forensicHash(d.id, e) || !ecdsaVerify(d.publicKey, e.hash, e.sig)) { deviceChainOk = false; break; }
    prev = e.hash;
  }
  const anchorsOk = verifyLogChain(anchors, ctx.secrets.server.publicKey) === -1;
  const bundle = { deviceId: d.id, devicePublicKey: d.publicKey, exportedAt: ctx.now(), headHash: prev, count: entries.length };
  return { ...bundle, deviceChainOk, anchorsOk, entries, anchors, serverPublicKey: ctx.secrets.server.publicKey, bundleSig: ctx.signServer(sha256Hex(canonical(bundle))) };
}
