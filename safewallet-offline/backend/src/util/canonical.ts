/**
 * JSON canónico determinista (claves ordenadas, sin espacios). Solo enteros, strings, booleanos, null,
 * arrays y objetos: los números no enteros están prohibidos para que Dart y TypeScript produzcan bytes idénticos.
 */
export function canonical(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error(`canonical: número no entero o inseguro: ${v}`);
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
    }
    default:
      throw new Error(`canonical: tipo no soportado ${typeof v}`);
  }
}
