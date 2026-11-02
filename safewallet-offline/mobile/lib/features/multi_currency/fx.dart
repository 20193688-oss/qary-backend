import '../../core/crypto/canonical.dart';
import '../../core/crypto/crypto.dart';
import '../../core/models.dart';

/// Snapshot de tasas firmado por el servidor. `ratesMicros[c]` = unidades de c por 1 USD (x1e6).
class RateSnapshot {
  RateSnapshot({required this.id, required this.asOf, required this.expiresAt, required this.ratesMicros, required this.marginBps, required this.source, required this.sig});
  final String id;
  final int asOf;
  final int expiresAt;
  final Map<String, int> ratesMicros;
  final int marginBps;
  final String source;
  final String sig;

  factory RateSnapshot.fromJson(Map<String, dynamic> j) => RateSnapshot(
      id: j['id'] as String, asOf: j['asOf'] as int, expiresAt: j['expiresAt'] as int,
      ratesMicros: (j['ratesMicros'] as Map).map((k, v) => MapEntry(k as String, v as int)),
      marginBps: j['marginBps'] as int, source: j['source'] as String, sig: j['sig'] as String);

  Map<String, dynamic> toJson() => {'id': id, 'base': 'USD', 'asOf': asOf, 'expiresAt': expiresAt, 'ratesMicros': ratesMicros, 'marginBps': marginBps, 'source': source, 'sig': sig};

  Map<String, dynamic> get signedBody => {'id': id, 'base': 'USD', 'asOf': asOf, 'expiresAt': expiresAt, 'ratesMicros': ratesMicros, 'marginBps': marginBps, 'source': source};

  Future<bool> verify(String serverPublicKey) => SwCrypto.verify(serverPublicKey, SwCrypto.utf8Bytes(canonicalJson(signedBody)), sig);

  bool isExpired(int now) => now > expiresAt;

  /// Unidades de [dst] por 1 [src], x1e6, redondeo al más cercano (idéntico al backend).
  int crossRateMicros(String src, String dst) {
    if (src == dst) return 1000000;
    final d = BigInt.from(ratesMicros[dst]!), s = BigInt.from(ratesMicros[src]!);
    return ((d * BigInt.from(1000000) * BigInt.two + s) ~/ (s * BigInt.two)).toInt();
  }

  int toUsdMinor(String currency, int minor) {
    final r = BigInt.from(ratesMicros[currency]!);
    return ((BigInt.from(minor) * BigInt.from(1000000) + r ~/ BigInt.two) ~/ r).toInt();
  }
}

/// Precio en moneda del pagador de [destMinor] con margen de seguridad (redondeo hacia arriba).
int payerPriceMinor(int destMinor, int rateMicros, int marginBps) {
  final num = BigInt.from(destMinor) * BigInt.from(1000000) * BigInt.from(10000 + marginBps);
  final den = BigInt.from(rateMicros) * BigInt.from(10000);
  return ((num + den - BigInt.one) ~/ den).toInt();
}

int fairPriceMinor(int destMinor, int rateMicros) => payerPriceMinor(destMinor, rateMicros, 0);

/// Almacén de tasas precargadas con validación de firma y vigencia.
class RateStore {
  RateStore(this.serverPublicKey, {Clock clock = systemClock}) : _clock = clock; // ignore: prefer_initializing_formals
  final String serverPublicKey;
  final Clock _clock;
  final Map<String, RateSnapshot> _byId = {};
  RateSnapshot? _latest;

  Future<void> add(RateSnapshot s) async {
    if (!await s.verify(serverPublicKey)) throw SwException('rates_bad_signature', 'snapshot de tasas con firma inválida');
    for (final c in supportedCurrencies) {
      if (!s.ratesMicros.containsKey(c) || s.ratesMicros[c]! <= 0) throw SwException('rates_incomplete', 'falta tasa para $c');
    }
    _byId[s.id] = s;
    if (_latest == null || s.asOf >= _latest!.asOf) _latest = s;
  }

  RateSnapshot? get latest => _latest;
  RateSnapshot? byId(String id) => _byId[id];

  RateSnapshot requireFresh({Duration grace = const Duration(hours: 24)}) {
    final s = _latest;
    if (s == null) throw SwException('no_rates', 'no hay tasas precargadas: conéctate para sincronizar');
    if (_clock() > s.expiresAt + grace.inMilliseconds) throw SwException('rates_stale', 'las tasas precargadas están demasiado viejas');
    return s;
  }
}
