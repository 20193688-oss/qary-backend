import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { Doc, Store } from './store.js';

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, 'schema.sql'), join(here, '../../src/db/schema.sql')];
    let sql = '';
    for (const p of candidates) { try { sql = readFileSync(p, 'utf8'); break; } catch { /* siguiente */ } }
    if (!sql) throw new Error('schema.sql no encontrado');
    await this.pool.query(sql);
  }
  async get<T extends Doc>(col: string, id: string): Promise<T | undefined> {
    const r = await this.pool.query('SELECT doc FROM documents WHERE col=$1 AND id=$2', [col, id]);
    return r.rows[0]?.doc as T | undefined;
  }
  async put<T extends Doc>(col: string, id: string, doc: T): Promise<void> {
    await this.pool.query(
      'INSERT INTO documents(col,id,doc) VALUES($1,$2,$3) ON CONFLICT (col,id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()',
      [col, id, JSON.stringify(doc)],
    );
  }
  async insert<T extends Doc>(col: string, id: string, doc: T): Promise<boolean> {
    const r = await this.pool.query('INSERT INTO documents(col,id,doc) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [col, id, JSON.stringify(doc)]);
    return (r.rowCount ?? 0) === 1;
  }
  async find<T extends Doc>(col: string, where: Record<string, string | number | boolean>): Promise<T[]> {
    const r = await this.pool.query('SELECT doc FROM documents WHERE col=$1 AND doc @> $2::jsonb ORDER BY created_at', [col, JSON.stringify(where)]);
    return r.rows.map((x) => x.doc as T);
  }
  async list<T extends Doc>(col: string, limit = 1000): Promise<T[]> {
    const r = await this.pool.query('SELECT doc FROM documents WHERE col=$1 ORDER BY created_at LIMIT $2', [col, limit]);
    return r.rows.map((x) => x.doc as T);
  }
  async remove(col: string, id: string): Promise<void> {
    await this.pool.query('DELETE FROM documents WHERE col=$1 AND id=$2', [col, id]);
  }
  /** Solo tests: vacía todas las colecciones. */
  async truncateAll(): Promise<void> { await this.pool.query('TRUNCATE documents'); }
  async close(): Promise<void> { await this.pool.end(); }
}
