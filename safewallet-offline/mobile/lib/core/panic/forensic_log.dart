import 'dart:convert';

import '../crypto/canonical.dart';
import '../crypto/crypto.dart';
import '../dual_agent/wal.dart';
import '../models.dart';
import '../secure_element/secure_element.dart';

/// Auditoría forense post-robo: cadena de custodia (hash chain) con contenido cifrado y firmado por el dispositivo.
/// Formato idéntico al esperado por `POST /v1/forensic/{deviceId}/logs`.
class ForensicLog {
  ForensicLog({required this.se, required this.wal, required this.deviceId, Clock clock = systemClock}) : _clock = clock;
  final SecureElement se;
  final EncryptedWal wal;
  final String deviceId;
  final Clock _clock;
  final List<Map<String, dynamic>> _entries = [];
  int uploadedUpTo = -1;

  Future<void> restore() async {
    for (final r in await wal.readAll()) {
      if (r.kind == 'forensic') _entries.add(r.data);
      if (r.kind == 'forensic_ack') uploadedUpTo = r.data['upTo'] as int;
    }
  }

  List<Map<String, dynamic>> get entries => List.unmodifiable(_entries);

  Future<Map<String, dynamic>> append(String type, String plaintext) async {
    if (!se.hasSecret('forensic')) await se.generateSecret('forensic');
    final index = _entries.length;
    final prev = index == 0 ? genesisHash : _entries.last['hash'] as String;
    final sealed = await se.aeadEncrypt('forensic', utf8.encode(plaintext), aad: 'forensic|$deviceId|$index');
    final blob = SwCrypto.b64u([...SwCrypto.unb64u(sealed['iv']!), ...SwCrypto.unb64u(sealed['ct']!), ...SwCrypto.unb64u(sealed['tag']!)]);
    final base = {'index': index, 'type': type, 'ts': _clock(), 'ciphertext': blob, 'prevHash': prev};
    final hash = await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(canonicalJson({'deviceId': deviceId, ...base})));
    final e = {...base, 'hash': hash, 'sig': await se.sign(SwCrypto.utf8Bytes(hash))};
    await wal.append('forensic', e);
    _entries.add(e);
    return e;
  }

  List<Map<String, dynamic>> pending() => _entries.where((e) => (e['index'] as int) > uploadedUpTo).toList();

  Future<void> markUploaded(int upTo) async {
    uploadedUpTo = upTo;
    await wal.append('forensic_ack', {'upTo': upTo});
  }

  /// Descifra una entrada (solo posible mientras exista el SE; el backend nunca ve el texto).
  Future<String> open(int index) async {
    final blob = SwCrypto.unb64u(_entries[index]['ciphertext'] as String);
    final plain = await se.aeadDecrypt('forensic', {'iv': SwCrypto.b64u(blob.sublist(0, 12)), 'ct': SwCrypto.b64u(blob.sublist(12, blob.length - 16)), 'tag': SwCrypto.b64u(blob.sublist(blob.length - 16))}, aad: 'forensic|$deviceId|$index');
    return utf8.decode(plain);
  }
}
