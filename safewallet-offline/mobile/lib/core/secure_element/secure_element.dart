import 'dart:convert';
import 'dart:typed_data';

import '../crypto/crypto.dart';

/// Capa de abstracción del Secure Element / TEE / StrongBox (Android) y Secure Enclave (iOS).
///
/// Contrato: la clave privada y las claves simétricas importadas NUNCA salen de esta interfaz;
/// el resto de la app solo puede pedir firmar, hacer ECDH, calcular HMAC o cifrar/descifrar con ellas.
abstract class SecureElement {
  /// Clave pública P-256 (0x04||X||Y, base64url).
  String get publicKey;
  bool get isWiped;
  String get kind;

  Future<String> sign(List<int> data);
  Future<Uint8List> ecdh(String peerPublicKey);

  /// Genera una clave simétrica dentro del chip (p. ej. clave del WAL).
  Future<void> generateSecret(String name);

  /// Desenvuelve (ECIES con la clave privada del chip) un mapa JSON de claves y las guarda dentro.
  /// [nameFor] devuelve el nombre de almacenamiento de cada campo secreto o null si el campo no es secreto;
  /// devuelve los campos no secretos (p. ej. `epoch`).
  Future<Map<String, dynamic>> importKeyMap(Map<String, dynamic> wrapped, String info, {required String? Function(String field) nameFor});

  Future<String> hmacHex(String name, List<int> data);
  Future<Map<String, String>> aeadEncrypt(String name, List<int> plain, {String? aad});
  Future<Uint8List> aeadDecrypt(String name, Map<String, dynamic> sealed, {String? aad});
  bool hasSecret(String name);
  Future<void> deleteSecret(String name);

  /// Borra irreversiblemente claves y secretos (Protocolo Escudo).
  Future<void> wipe();

  /// Evidencia para la attestation del backend (la plataforma real añade Play Integrity / DeviceCheck).
  Future<String> platformIntegrityToken();
}

/// SIMULADO: implementación por software con las mismas garantías de API, pero sin aislamiento de hardware.
/// En un dispositivo físico debe sustituirse por una implementación que use Android Keystore (StrongBox) /
/// iOS Secure Enclave mediante un MethodChannel (ver docs/SECURITY.md, «Qué es simulado»).
class SoftwareSecureElement extends SecureElement {
  SoftwareSecureElement._(this._kp);
  SwKeyPair? _kp;
  final Map<String, Uint8List> _secrets = {};
  bool _wiped = false;

  static Future<SoftwareSecureElement> create() async => SoftwareSecureElement._(await SwCrypto.generateKeyPair());

  /// Para tests deterministas.
  static SoftwareSecureElement fromKeyPair(SwKeyPair kp) => SoftwareSecureElement._(kp);

  void _live() {
    if (_wiped || _kp == null) throw StateError('Secure Element borrado (wipe)');
  }

  @override
  String get kind => 'software-simulated';
  @override
  bool get isWiped => _wiped;
  @override
  String get publicKey {
    _live();
    return _kp!.publicRaw;
  }

  @override
  Future<String> sign(List<int> data) async {
    _live();
    return SwCrypto.sign(_kp!, data);
  }

  @override
  Future<Uint8List> ecdh(String peerPublicKey) async {
    _live();
    return SwCrypto.ecdh(_kp!, peerPublicKey);
  }

  @override
  Future<void> generateSecret(String name) async {
    _live();
    _secrets[name] = SwCrypto.randomBytes(32);
  }

  @override
  Future<Map<String, dynamic>> importKeyMap(Map<String, dynamic> wrapped, String info, {required String? Function(String field) nameFor}) async {
    _live();
    final plain = await SwCrypto.unwrap(_kp!, wrapped, info);
    final map = jsonDecode(utf8.decode(plain)) as Map<String, dynamic>;
    final rest = <String, dynamic>{};
    for (final e in map.entries) {
      final n = nameFor(e.key);
      if (n == null) {
        rest[e.key] = e.value;
      } else {
        _secrets[n] = SwCrypto.unb64u(e.value as String);
      }
    }
    return rest;
  }

  Uint8List _key(String name) {
    _live();
    final k = _secrets[name];
    if (k == null) throw StateError('secreto inexistente en el SE: $name');
    return k;
  }

  @override
  Future<String> hmacHex(String name, List<int> data) => SwCrypto.hmacHex(_key(name), data);
  @override
  Future<Map<String, String>> aeadEncrypt(String name, List<int> plain, {String? aad}) => SwCrypto.aesEncrypt(_key(name), plain, aad: aad);
  @override
  Future<Uint8List> aeadDecrypt(String name, Map<String, dynamic> sealed, {String? aad}) => SwCrypto.aesDecrypt(_key(name), sealed, aad: aad);
  @override
  bool hasSecret(String name) => !_wiped && _secrets.containsKey(name);
  @override
  Future<void> deleteSecret(String name) async => _secrets.remove(name);

  @override
  Future<void> wipe() async {
    for (final k in _secrets.values) {
      k.fillRange(0, k.length, 0);
    }
    _secrets.clear();
    _kp = null;
    _wiped = true;
  }

  @override
  Future<String> platformIntegrityToken() async => 'MOCK-OK-software-se';
}
