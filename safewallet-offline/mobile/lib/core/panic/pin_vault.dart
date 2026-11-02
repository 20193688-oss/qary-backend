import 'package:cryptography/cryptography.dart';

import '../crypto/crypto.dart';
import '../dual_agent/wal.dart';
import '../models.dart';
import '../secure_element/secure_element.dart';

enum PinResult { real, duress, wrong, locked }

/// Verificador local de PIN real y PIN de coacción: PBKDF2-HMAC-SHA256 + pepper HMAC con clave del Secure Element,
/// con bloqueo tras 5 fallos en 15 minutos (anti fuerza bruta).
class PinVault {
  PinVault({required this.se, required this.wal, Clock clock = systemClock, this.iterations = 100000}) : _clock = clock;
  final SecureElement se;
  final EncryptedWal wal;
  final Clock _clock;
  final int iterations;
  String? _salt, _real, _duress;
  final List<int> _fails = [];

  static const maxFails = 5;
  static const lockMs = 15 * 60 * 1000;

  Future<String> _derive(String pin, String salt) async {
    final k = await Pbkdf2(macAlgorithm: Hmac.sha256(), iterations: iterations, bits: 256).deriveKeyFromPassword(password: pin, nonce: SwCrypto.unb64u(salt));
    return se.hmacHex('pin-pepper', await k.extractBytes());
  }

  Future<void> restore() async {
    for (final r in await wal.readAll()) {
      if (r.kind == 'pins') {
        _salt = r.data['salt'] as String;
        _real = r.data['real'] as String;
        _duress = r.data['duress'] as String;
      } else if (r.kind == 'pin_fail') {
        _fails.add(r.data['ts'] as int);
      } else if (r.kind == 'pin_ok') {
        _fails.clear();
      }
    }
  }

  Future<void> setPins(String pin, String duressPin) async {
    if (!RegExp(r'^\d{4,8}$').hasMatch(pin) || !RegExp(r'^\d{4,8}$').hasMatch(duressPin)) throw SwException('bad_pin', 'los PIN deben tener 4 a 8 dígitos');
    if (pin == duressPin) throw SwException('bad_pin', 'el PIN de coacción debe ser distinto del PIN real');
    if (!se.hasSecret('pin-pepper')) await se.generateSecret('pin-pepper');
    _salt = SwCrypto.b64u(SwCrypto.randomBytes(16));
    _real = await _derive(pin, _salt!);
    _duress = await _derive(duressPin, _salt!);
    await wal.append('pins', {'salt': _salt, 'real': _real, 'duress': _duress});
  }

  bool get locked {
    final now = _clock();
    return _fails.where((t) => now - t < lockMs).length >= maxFails;
  }

  Future<PinResult> verify(String pin) async {
    if (_salt == null) throw SwException('pins_not_set', 'aún no se configuraron los PIN');
    if (locked) return PinResult.locked;
    final h = await _derive(pin, _salt!);
    // se comparan ambos siempre (tiempo constante respecto a cuál coincide)
    final isReal = SwCrypto.constantTimeEquals(h, _real!);
    final isDuress = SwCrypto.constantTimeEquals(h, _duress!);
    if (isReal) {
      _fails.clear();
      await wal.append('pin_ok', {});
      return PinResult.real;
    }
    if (isDuress) return PinResult.duress;
    final t = _clock();
    _fails.add(t);
    await wal.append('pin_fail', {'ts': t});
    return PinResult.wrong;
  }
}
