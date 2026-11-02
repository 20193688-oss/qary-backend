/// Tipos compartidos. Los vouchers/intents viajan como mapas JSON canónicos para que la firma
/// sea idéntica entre Dart y el backend.
const supportedCurrencies = ['PEN', 'USD', 'EUR', 'CRC', 'VES', 'COP'];

typedef Clock = int Function();
int systemClock() => DateTime.now().millisecondsSinceEpoch;

class SwException implements Exception {
  SwException(this.code, this.message, [this.details]);
  final String code;
  final String message;
  final Object? details;
  @override
  String toString() => 'SwException($code): $message';
}

class OfflineLimitExceeded extends SwException {
  OfflineLimitExceeded(String message) : super('offline_limit_exceeded', message);
}

class StepUpRequired extends SwException {
  StepUpRequired(this.score) : super('step_up_required', 'riesgo $score > 70: requiere biometría + PIN + confirmación SMS');
  final int score;
}

class DeviceFrozen extends SwException {
  DeviceFrozen() : super('device_frozen', 'el dispositivo financiero está congelado (Protocolo Escudo o bloqueo preventivo)');
}

class NoTokensAvailable extends SwException {
  NoTokensAvailable() : super('no_tokens', 'no quedan tokens offline: conéctate para recargar');
}

class DeviceCertificate {
  DeviceCertificate({required this.deviceId, required this.publicKey, required this.expiresAt, required this.sig});
  final String deviceId;
  final String publicKey;
  final int expiresAt;
  final String sig;

  factory DeviceCertificate.fromJson(Map<String, dynamic> j) => DeviceCertificate(
      deviceId: j['deviceId'] as String, publicKey: j['publicKey'] as String, expiresAt: j['expiresAt'] as int, sig: j['sig'] as String);

  Map<String, dynamic> toJson() => {'deviceId': deviceId, 'publicKey': publicKey, 'expiresAt': expiresAt, 'sig': sig};
  Map<String, dynamic> get body => {'deviceId': deviceId, 'publicKey': publicKey, 'expiresAt': expiresAt};
}

/// Entrada del ledger offline firmada y encadenada (hash + HMAC + ECDSA).
class LedgerEntry {
  LedgerEntry({required this.seq, required this.counter, required this.prevHash, required this.keyEpoch, required this.type, required this.payload, required this.hash, required this.mac, required this.sig});
  final int seq;
  final int counter;
  final String prevHash;
  final int keyEpoch;
  final String type;
  final Map<String, dynamic> payload;
  final String hash;
  final String mac;
  final String sig;

  Map<String, dynamic> toJson() => {'seq': seq, 'counter': counter, 'prevHash': prevHash, 'keyEpoch': keyEpoch, 'type': type, 'payload': payload, 'hash': hash, 'mac': mac, 'sig': sig};

  factory LedgerEntry.fromJson(Map<String, dynamic> j) => LedgerEntry(
      seq: j['seq'] as int, counter: j['counter'] as int, prevHash: j['prevHash'] as String, keyEpoch: j['keyEpoch'] as int, type: j['type'] as String,
      payload: Map<String, dynamic>.from(j['payload'] as Map), hash: j['hash'] as String, mac: j['mac'] as String, sig: j['sig'] as String);
}

const genesisHash = '0000000000000000000000000000000000000000000000000000000000000000';
