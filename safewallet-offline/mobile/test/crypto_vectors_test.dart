import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:safewallet_offline/core/crypto/canonical.dart';
import 'package:safewallet_offline/core/crypto/crypto.dart';

Map<String, dynamic> loadVectors() => jsonDecode(File('test/vectors.json').readAsStringSync()) as Map<String, dynamic>;

void main() {
  final v = loadVectors();

  test('JSON canónico idéntico a TypeScript', () {
    for (final c in v['canonical'] as List) {
      expect(canonicalJson(jsonDecode(c['json'] as String)), c['expected']);
    }
    expect(() => canonicalJson({'a': 1.5}), throwsFormatException);
  });

  test('ECDSA: verifica firma generada por Node y rechaza adulteración', () async {
    final e = v['ecdsa'] as Map<String, dynamic>;
    expect(await SwCrypto.verify(e['publicKey'], utf8.encode(e['message']), e['sig']), isTrue);
    expect(await SwCrypto.verify(e['publicKey'], utf8.encode('otro'), e['sig']), isFalse);
  });

  test('ECDSA: la firma de Dart tiene formato P1363 (64 bytes) y verifica', () async {
    final kp = await SwCrypto.generateKeyPair();
    for (var i = 0; i < 20; i++) {
      final sig = await SwCrypto.sign(kp, utf8.encode('msg $i'));
      expect(SwCrypto.unb64u(sig).length, 64);
      expect(await SwCrypto.verify(kp.publicRaw, utf8.encode('msg $i'), sig), isTrue);
    }
  });

  test('ECIES: abre un envoltorio creado por el backend', () async {
    final e = v['ecies'] as Map<String, dynamic>;
    final jwk = e['privateJwk'] as Map<String, dynamic>;
    final kp = SwKeyPair.fromJwk(d: jwk['d'], x: jwk['x'], y: jwk['y']);
    expect(kp.publicRaw, e['publicKey']);
    final plain = await SwCrypto.unwrap(kp, e['wrapped'] as Map<String, dynamic>, e['info']);
    expect(SwCrypto.b64u(plain), e['plaintext']);
    final w = await SwCrypto.wrapFor(kp.publicRaw, utf8.encode('ida y vuelta'), 'x');
    expect(utf8.decode(await SwCrypto.unwrap(kp, w, 'x')), 'ida y vuelta');
  });

  test('HKDF, AES-GCM, HMAC y SHA-256 coinciden con Node', () async {
    final h = v['hkdf'] as Map<String, dynamic>;
    final key = await SwCrypto.hkdf(SwCrypto.unhex(h['ikm']), utf8.encode(h['salt']), h['info']);
    expect(SwCrypto.hex(key), h['out']);
    final a = v['aes'] as Map<String, dynamic>;
    expect(utf8.decode(await SwCrypto.aesDecrypt(SwCrypto.unhex(a['key']), a['sealed'] as Map<String, dynamic>, aad: a['aad'])), a['plaintext']);
    expect(() => SwCrypto.aesDecrypt(SwCrypto.unhex(a['key']), a['sealed'] as Map<String, dynamic>, aad: 'otro'), throwsA(anything));
    final m = v['hmac'] as Map<String, dynamic>;
    expect(await SwCrypto.hmacHex(SwCrypto.unhex(m['key']), utf8.encode(m['data'])), m['out']);
    final s = v['sha256'] as Map<String, dynamic>;
    expect(await SwCrypto.sha256Hex(utf8.encode(s['data'])), s['out']);
  });
}
