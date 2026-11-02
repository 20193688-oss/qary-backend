/// JSON canónico determinista: idéntico byte a byte al de `backend/src/util/canonical.ts`.
/// Solo enteros, strings, booleanos, null, listas y mapas (los doubles están prohibidos).
String canonicalJson(Object? v) {
  if (v == null) return 'null';
  if (v is String) return _quote(v);
  if (v is bool) return v ? 'true' : 'false';
  if (v is int) return v.toString();
  if (v is List) return '[${v.map(canonicalJson).join(',')}]';
  if (v is Map) {
    final keys = v.keys.map((k) => k as String).where((k) => v[k] != null || v.containsKey(k)).toList()..sort();
    final parts = <String>[];
    for (final k in keys) {
      if (v[k] == null && !_keepNull(v, k)) continue;
      parts.add('${_quote(k)}:${canonicalJson(v[k])}');
    }
    return '{${parts.join(',')}}';
  }
  throw FormatException('canonicalJson: tipo no soportado (${v.runtimeType}); los números deben ser enteros');
}

// En TypeScript las claves con `undefined` se omiten, pero `null` explícito se serializa; en Dart `null` explícito también.
bool _keepNull(Map<dynamic, dynamic> m, String k) => m.containsKey(k);

/// Escape equivalente a JSON.stringify de JavaScript.
String _quote(String s) {
  final b = StringBuffer('"');
  for (final r in s.runes) {
    switch (r) {
      case 0x22:
        b.write(r'\"');
      case 0x5c:
        b.write(r'\\');
      case 0x08:
        b.write(r'\b');
      case 0x0c:
        b.write(r'\f');
      case 0x0a:
        b.write(r'\n');
      case 0x0d:
        b.write(r'\r');
      case 0x09:
        b.write(r'\t');
      default:
        if (r < 0x20) {
          b.write('\\u${r.toRadixString(16).padLeft(4, '0')}');
        } else {
          b.writeCharCode(r);
        }
    }
  }
  b.write('"');
  return b.toString();
}
