import 'dart:convert';

import 'package:safewallet_offline/core/crypto/canonical.dart';
import 'package:safewallet_offline/core/crypto/crypto.dart';
import 'package:safewallet_offline/core/dual_agent/bus.dart';
import 'package:safewallet_offline/core/dual_agent/offline_agent.dart';
import 'package:safewallet_offline/core/dual_agent/wal.dart';
import 'package:safewallet_offline/core/secure_element/secure_element.dart';

class TestClock {
  int t = DateTime.utc(2026, 11, 2, 15).millisecondsSinceEpoch;
  int call() => t;
}

/// Autoridad de pruebas: hace lo que haría el backend (certifica dispositivos, firma tasas, entrega claves y tokens).
class TestAuthority {
  TestAuthority._(this.kp, this.clock);
  final SwKeyPair kp;
  final TestClock clock;
  final Map<String, Map<String, List<int>>> keys = {}; // deviceId -> {ledger, sms}
  final Map<String, List<int>> luks = {}; // token -> luk
  String get publicKey => kp.publicRaw;

  static Future<TestAuthority> create(TestClock clock) async => TestAuthority._(await SwCrypto.generateKeyPair(), clock);

  static Future<String> deviceIdFor(String publicKey) async => (await SwCrypto.sha256Hex(SwCrypto.unb64u(publicKey))).substring(0, 32);

  Future<Map<String, dynamic>> snapshot({int marginBps = 200, Map<String, int>? override, String id = 'rs_test'}) async {
    final rates = {'USD': 1000000, 'PEN': 3750000, 'EUR': 920000, 'CRC': 520000000, 'VES': 36500000, 'COP': 4000000000, ...?override};
    final body = {'id': id, 'base': 'USD', 'asOf': clock.t, 'expiresAt': clock.t + 24 * 3600 * 1000, 'ratesMicros': rates, 'marginBps': marginBps, 'source': 'test'};
    return {...body, 'sig': await SwCrypto.sign(kp, SwCrypto.utf8Bytes(canonicalJson(body)))};
  }

  Future<Map<String, dynamic>> attestResponse(SecureElement se) async {
    final id = await deviceIdFor(se.publicKey);
    final ledger = SwCrypto.randomBytes(32), sms = SwCrypto.randomBytes(32);
    keys[id] = {'ledger': ledger, 'sms': sms};
    final certBody = {'deviceId': id, 'publicKey': se.publicKey, 'expiresAt': clock.t + 30 * 86400000};
    final plain = canonicalJson({'epoch': 1, 'ledgerKey': SwCrypto.b64u(ledger), 'smsKey': SwCrypto.b64u(sms)});
    return {
      'deviceId': id, 'trusted': true, 'serverPublicKey': publicKey, 'certificate': {...certBody, 'sig': await SwCrypto.sign(kp, SwCrypto.utf8Bytes(canonicalJson(certBody)))},
      'keys': {'epoch': 1, 'wrapped': await SwCrypto.wrapFor(se.publicKey, utf8.encode(plain), 'sw-keys|$id|1')},
      'rates': await snapshot(),
    };
  }

  Future<Map<String, dynamic>> tokenizeResponse(SecureElement se, String deviceId, {int count = 5, int ttlHours = 72}) async {
    final toks = <Map<String, dynamic>>[];
    final lukMap = <String, String>{};
    for (var i = 0; i < count; i++) {
      final t = '5${SwCrypto.hex(SwCrypto.randomBytes(8)).replaceAll(RegExp(r'[a-f]'), '1').substring(0, 15)}';
      final luk = SwCrypto.randomBytes(32);
      luks[t] = luk;
      lukMap[t] = SwCrypto.b64u(luk);
      toks.add({'token': t, 'expiresAt': clock.t + ttlHours * 3600000});
    }
    return {'cardRef': 'card_test', 'tokens': toks, 'lukBundle': await SwCrypto.wrapFor(se.publicKey, utf8.encode(canonicalJson(lukMap)), 'sw-luk|$deviceId')};
  }
}

class Phone {
  Phone(this.se, this.wal, this.store, this.agent, this.bus, this.id);
  final SoftwareSecureElement se;
  final EncryptedWal wal;
  final MemoryBlobStore store;
  final OfflineAgent agent;
  final EventBus bus;
  final String id;

  static Future<Phone> provisioned(TestAuthority auth, TestClock clock, {int tokens = 8, OfflineProfile profile = const OfflineProfile(), bool withRates = true}) async {
    final se = await SoftwareSecureElement.create();
    await se.generateSecret('wal');
    final store = MemoryBlobStore();
    final wal = EncryptedWal(store, se);
    final bus = EventBus();
    final agent = OfflineAgent(se: se, wal: wal, bus: bus, clock: clock.call);
    await agent.applyAttestation(await auth.attestResponse(se));
    await agent.applyTokens(await auth.tokenizeResponse(se, agent.deviceId!, count: tokens));
    await agent.setProfile(profile);
    return Phone(se, wal, store, agent, bus, agent.deviceId!);
  }
}
