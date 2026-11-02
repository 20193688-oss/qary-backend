/**
 * Almacén de documentos con semántica transaccional mínima.
 * - `insert` es atómico y devuelve false si el id ya existe (idempotencia y detección de doble gasto).
 * - `find` filtra por igualdad de campos de primer nivel.
 */
export type Doc = Record<string, unknown>;

export interface Store {
  get<T extends Doc>(col: string, id: string): Promise<T | undefined>;
  put<T extends Doc>(col: string, id: string, doc: T): Promise<void>;
  insert<T extends Doc>(col: string, id: string, doc: T): Promise<boolean>;
  find<T extends Doc>(col: string, where: Record<string, string | number | boolean>): Promise<T[]>;
  list<T extends Doc>(col: string, limit?: number): Promise<T[]>;
  remove(col: string, id: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  private cols = new Map<string, Map<string, string>>();
  private c(col: string): Map<string, string> {
    let m = this.cols.get(col);
    if (!m) { m = new Map(); this.cols.set(col, m); }
    return m;
  }
  async get<T extends Doc>(col: string, id: string): Promise<T | undefined> {
    const s = this.c(col).get(id);
    return s === undefined ? undefined : (JSON.parse(s) as T);
  }
  async put<T extends Doc>(col: string, id: string, doc: T): Promise<void> { this.c(col).set(id, JSON.stringify(doc)); }
  async insert<T extends Doc>(col: string, id: string, doc: T): Promise<boolean> {
    const m = this.c(col);
    if (m.has(id)) return false;
    m.set(id, JSON.stringify(doc));
    return true;
  }
  async find<T extends Doc>(col: string, where: Record<string, string | number | boolean>): Promise<T[]> {
    const out: T[] = [];
    for (const s of this.c(col).values()) {
      const d = JSON.parse(s) as T;
      if (Object.entries(where).every(([k, v]) => d[k] === v)) out.push(d);
    }
    return out;
  }
  async list<T extends Doc>(col: string, limit = 1000): Promise<T[]> {
    return [...this.c(col).values()].slice(0, limit).map((s) => JSON.parse(s) as T);
  }
  async remove(col: string, id: string): Promise<void> { this.c(col).delete(id); }
  async close(): Promise<void> { /* nada */ }
}
