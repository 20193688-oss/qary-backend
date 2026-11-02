import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:pointycastle/export.dart' hide Mac;

/// Primitivas criptográficas reales (ECDSA P-256, ECDH, HKDF, AES-256-GCM, HMAC/SHA-256).
/// Formatos idénticos a `backend/src/util/crypto.ts`:
///  - clave pública: punto sin comprimir 0x04||X||Y en base64url
///  - firma ECDSA: r||s (IEEE P1363, 64 bytes) en base64url
class SwCrypto {
  SwCrypto._();

  static final _aes = AesGcm.with256bits();
  static final _sha = Sha256();
  static final _hmac = Hmac.sha256();
  static final _rng = Random.secure();

  static String b64u(List<int> b) => base64Url.encode(b).replaceAll('=', '');
  static Uint8List unb64u(String s) => Uint8List.fromList(base64Url.decode(base64Url.normalize(s)));
  static String hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  static Uint8List unhex(String s) => Uint8List.fromList([for (var i = 0; i < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16)]);
  static Uint8List utf8Bytes(String s) => Uint8List.fromList(utf8.encode(s));

  static Uint8List randomBytes(int n) => Uint8List.fromList(List<int>.generate(n, (_) => _rng.nextInt(256)));
  static String randomHex(int n) => hex(randomBytes(n));

  static Future<String> sha256Hex(List<int> data) async => hex((await _sha.hash(data)).bytes);

  static Future<String> hmacHex(List<int> key, List<int> data) async =>
      hex((await _hmac.calculateMac(data, secretKey: SecretKey(key))).bytes);

  static Future<Uint8List> hkdf(List<int> ikm, List<int> salt, String info, [int len = 32]) async {
    final k = await Hkdf(hmac: _hmac, outputLength: len).deriveKey(secretKey: SecretKey(ikm), nonce: salt, info: utf8.encode(info));
    return Uint8List.fromList(await k.extractBytes());
  }

  // ---- ECDSA / ECDH (pointycastle, P-256; firmas deterministas RFC 6979)
  static final ECDomainParameters _curve = ECDomainParameters('prime256v1');

  static Future<SwKeyPair> generateKeyPair() async {
    final rnd = FortunaRandom()..seed(KeyParameter(randomBytes(32)));
    final gen = ECKeyGenerator()..init(ParametersWithRandom(ECKeyGeneratorParameters(_curve), rnd));
    final pair = gen.generateKeyPair();
    final priv = pair.privateKey as ECPrivateKey;
    final pub = pair.publicKey as ECPublicKey;
    return SwKeyPair._(_bytes(priv.d!, 32), _bytes(pub.Q!.x!.toBigInteger()!, 32), _bytes(pub.Q!.y!.toBigInteger()!, 32));
  }

  static Uint8List _bytes(BigInt v, int len) {
    final out = Uint8List(len);
    var x = v;
    for (var i = len - 1; i >= 0; i--) {
      out[i] = (x & BigInt.from(0xff)).toInt();
      x >>= 8;
    }
    return out;
  }

  static BigInt _big(List<int> b) => b.fold(BigInt.zero, (a, x) => (a << 8) | BigInt.from(x));

  static ECPublicKey publicFromRaw(String raw) {
    final b = unb64u(raw);
    if (b.length != 65 || b[0] != 4) throw const FormatException('clave pública P-256 inválida');
    final pt = _curve.curve.createPoint(_big(b.sublist(1, 33)), _big(b.sublist(33)));
    // validación explícita de pertenencia a la curva (evita ataques de curva inválida)
    final x = pt.x!.toBigInteger()!, y = pt.y!.toBigInteger()!;
    final lhs = (y * y) % _p;
    final rhs = (x * x * x + _curve.curve.a!.toBigInteger()! * x + _curve.curve.b!.toBigInteger()!) % _p;
    if (lhs != rhs) throw const FormatException('el punto no pertenece a P-256');
    return ECPublicKey(pt, _curve);
  }

  static final BigInt _p = BigInt.parse('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff', radix: 16);

  static Future<String> sign(SwKeyPair kp, List<int> data) async {
    final signer = ECDSASigner(SHA256Digest(), HMac(SHA256Digest(), 64))
      ..init(true, PrivateKeyParameter<ECPrivateKey>(ECPrivateKey(_big(kp.d), _curve)));
    final sig = signer.generateSignature(Uint8List.fromList(data)) as ECSignature;
    return b64u([..._bytes(sig.r, 32), ..._bytes(sig.s, 32)]);
  }

  static Future<bool> verify(String publicKeyRaw, List<int> data, String sigB64) async {
    try {
      final sig = unb64u(sigB64);
      if (sig.length != 64) return false;
      final signer = ECDSASigner(SHA256Digest())..init(false, PublicKeyParameter<ECPublicKey>(publicFromRaw(publicKeyRaw)));
      return signer.verifySignature(Uint8List.fromList(data), ECSignature(_big(sig.sublist(0, 32)), _big(sig.sublist(32))));
    } catch (_) {
      return false;
    }
  }

  static Future<Uint8List> ecdh(SwKeyPair mine, String peerPublicRaw) async {
    final agr = ECDHBasicAgreement()..init(ECPrivateKey(_big(mine.d), _curve));
    return _bytes(agr.calculateAgreement(publicFromRaw(peerPublicRaw)), 32);
  }

  // ---- AES-256-GCM  (iv 12 bytes, tag 16 bytes; formato {iv, ct, tag} base64url)
  static Future<Map<String, String>> aesEncrypt(List<int> key, List<int> plain, {String? aad}) async {
    final box = await _aes.encrypt(plain, secretKey: SecretKey(key), aad: aad == null ? const [] : utf8.encode(aad));
    return {'iv': b64u(box.nonce), 'ct': b64u(box.cipherText), 'tag': b64u(box.mac.bytes)};
  }

  static Future<Uint8List> aesDecrypt(List<int> key, Map<String, dynamic> sealed, {String? aad}) async {
    final box = SecretBox(unb64u(sealed['ct'] as String), nonce: unb64u(sealed['iv'] as String), mac: Mac(unb64u(sealed['tag'] as String)));
    return Uint8List.fromList(await _aes.decrypt(box, secretKey: SecretKey(key), aad: aad == null ? const [] : utf8.encode(aad)));
  }

  // ---- ECIES (P-256 efímera + ECDH + HKDF + AES-GCM), compatible con `wrapFor` del backend
  static Future<Map<String, String>> wrapFor(String devicePublicRaw, List<int> plain, String info) async {
    final eph = await generateKeyPair();
    final shared = await ecdh(eph, devicePublicRaw);
    final key = await hkdf(shared, const [], info);
    return {'epk': eph.publicRaw, ...await aesEncrypt(key, plain, aad: info)};
  }

  static Future<Uint8List> unwrap(SwKeyPair mine, Map<String, dynamic> w, String info) async {
    final shared = await ecdh(mine, w['epk'] as String);
    final key = await hkdf(shared, const [], info);
    return aesDecrypt(key, w, aad: info);
  }

  static bool constantTimeEquals(String a, String b) {
    if (a.length != b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) {
      d |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return d == 0;
  }
}

/// Par de claves P-256 en memoria (la versión respaldada por hardware vive detrás de `SecureElement`).
class SwKeyPair {
  SwKeyPair._(this.d, this.x, this.y) : publicRaw = SwCrypto.b64u([4, ...x, ...y]);
  final Uint8List d;
  final Uint8List x;
  final Uint8List y;
  final String publicRaw;

  factory SwKeyPair.fromJwk({required String d, required String x, required String y}) =>
      SwKeyPair._(SwCrypto.unb64u(d), SwCrypto.unb64u(x), SwCrypto.unb64u(y));

  Map<String, String> toJwk() => {'d': SwCrypto.b64u(d), 'x': SwCrypto.b64u(x), 'y': SwCrypto.b64u(y)};
}
