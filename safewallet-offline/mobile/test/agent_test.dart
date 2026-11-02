import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:safewallet_offline/core/crypto/canonical.dart';
import 'package:safewallet_offline/core/crypto/crypto.dart';
import 'package:safewallet_offline/core/dual_agent/bus.dart';
import 'package:safewallet_offline/core/dual_agent/offline_agent.dart';
import 'package:safewallet_offline/core/dual_agent/wal.dart';
import 'package:safewallet_offline/core/models.dart';
import 'package:safewallet_offline/features/multi_currency/fx.dart';

import 'support.dart';

void main() {
  late TestClock clock;
  late TestAuthority auth;
  setUp(() async {
    clock = TestClock();
    auth = await TestAuthority.create(clock);
  });

  test('pago offline: voucher firmado, ARQC verificable con la LUK y entrada de ledger encadenada', () async {
    final a = await Phone.provisioned(auth, clock);
    final b = await Phone.provisioned(auth, clock);
    final art = await a.agent.createPayment(PaymentRequest(payeeDeviceId: b.id, amountMinor: 1500, currency: 'PEN'));
    final intent = Map<String, dynamic>.from(art.voucher['intent'] as Map);
    expect(await SwCrypto.verify(a.se.publicKey, SwCrypto.utf8Bytes(canonicalJson(intent)), art.voucher['payerSig'] as String), isTrue);
    final luk = auth.luks[intent['token']]!;
    final arqc = (await SwCrypto.hmacHex(luk, SwCrypto.utf8Bytes(canonicalJson({'token': intent['token'], 'amountMinor': 1500, 'currency': 'PEN', 'counter': intent['counter'], 'txId': intent['txId']})))).substring(0, 32);
    expect(intent['arqc'], arqc);
    expect(art.entry.seq, 0);
    expect(art.entry.type, 'PAY_OUT');
    // MAC del ledger verificable con la clave que conoce el "servidor"
    expect(art.entry.mac, await SwCrypto.hmacHex(auth.keys[a.id]!['ledger']!, SwCrypto.utf8Bytes(art.entry.hash)));
    expect(await a.agent.verifyLocalLedger(), -1);
  });

  test('los tokens son de un solo uso y se agotan', () async {
    final a = await Phone.provisioned(auth, clock, tokens: 2);
    for (var i = 0; i < 2; i++) {
      await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN'));
    }
    expect(a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN')), throwsA(isA<NoTokensAvailable>()));
  });

  test('límite DURO diario y por operación: nunca se excede offline', () async {
    final a = await Phone.provisioned(auth, clock, profile: const OfflineProfile(dailyLimitUsdMinor: 3000, perTxLimitUsdMinor: 2000), tokens: 10);
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 5000, currency: 'PEN')); // ~USD 13.3
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 5000, currency: 'PEN')); // ~USD 26.7
    await expectLater(a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 5000, currency: 'PEN')), throwsA(isA<OfflineLimitExceeded>()));
    await expectLater(a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 20000, currency: 'PEN')), throwsA(isA<OfflineLimitExceeded>()));
    // al día siguiente el cupo se renueva
    clock.t += 24 * 3600 * 1000;
    await auth.snapshot(id: 'rs_day2').then((s) async => a.agent.addRates(await _snap(s)));
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 5000, currency: 'PEN'));
  });

  test('riesgo > 70 exige biometría + PIN y adjunta prueba SMS verificable', () async {
    final a = await Phone.provisioned(auth, clock, profile: const OfflineProfile(dailyLimitUsdMinor: 12000, perTxLimitUsdMinor: 10000), tokens: 10);
    for (var i = 0; i < 3; i++) {
      await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN'));
    }
    const big = PaymentRequest(payeeRef: 'x', amountMinor: 36900, currency: 'PEN', country: 'CO');
    await expectLater(a.agent.createPayment(big), throwsA(isA<StepUpRequired>()));
    final art = await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 36900, currency: 'PEN', country: 'CO', stepUp: StepUp(biometric: true, pin: true)));
    final i = Map<String, dynamic>.from(art.voucher['intent'] as Map);
    expect(art.riskScore, greaterThan(70));
    expect((i['stepUp'] as Map)['smsProof'], (await SwCrypto.hmacHex(auth.keys[a.id]!['sms']!, SwCrypto.utf8Bytes(i['txId'] as String))).substring(0, 16));
  });

  test('multi-divisa: USD desde PEN con margen ±2 % y tasa/snapshot en el intent', () async {
    final a = await Phone.provisioned(auth, clock);
    final art = await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 1000, currency: 'USD'));
    final i = Map<String, dynamic>.from(art.voucher['intent'] as Map);
    expect(i['payerAmountMinor'], 3825);
    expect(i['marginBps'], 200);
    expect(i['rateSnapshotId'], 'rs_test');
    final pv = await a.agent.preview(const PaymentRequest(payeeRef: 'x', amountMinor: 1000, currency: 'USD'));
    expect(pv['payerAmountMinor'], 3825);
  });

  test('tasas vencidas (> 24 h de gracia) o ausentes bloquean el pago', () async {
    final a = await Phone.provisioned(auth, clock);
    clock.t += 3 * 86400 * 1000;
    await expectLater(a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN')), throwsA(predicate((e) => e is SwException && e.code == 'rates_stale')));
  });

  test('un snapshot con firma falsa se rechaza', () async {
    final a = await Phone.provisioned(auth, clock);
    final s = await auth.snapshot(id: 'rs_evil', override: {'PEN': 1000000});
    s['ratesMicros'] = {...(s['ratesMicros'] as Map), 'PEN': 100};
    await expectLater(a.agent.addRates(await _snap(s)), throwsA(predicate((e) => e is SwException && e.code == 'rates_bad_signature')));
  });

  test('anti-tampering: modificar el WAL cifrado invalida la lectura; modificar una entrada rompe la cadena', () async {
    final a = await Phone.provisioned(auth, clock);
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN'));
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN'));
    // 1) alterar un byte del texto cifrado en disco
    final lines = await a.store.readLines();
    final j = jsonDecode(lines.last) as Map<String, dynamic>;
    final ct = SwCrypto.unb64u(j['ct'] as String);
    ct[0] ^= 1;
    j['ct'] = SwCrypto.b64u(ct);
    final broken = MemoryBlobStore()..lines.addAll([...lines.take(lines.length - 1), jsonEncode(j)]);
    final reopened = OfflineAgent(se: a.se, wal: EncryptedWal(broken, a.se), bus: EventBus(), clock: clock.call);
    await expectLater(reopened.restore(), throwsA(predicate((e) => e is SwException && e.code == 'wal_corrupt')));
    // 2) reordenar registros (AAD con índice) también falla
    final swapped = MemoryBlobStore()..lines.addAll([...lines.take(lines.length - 2), lines.last, lines[lines.length - 2]]);
    await expectLater(OfflineAgent(se: a.se, wal: EncryptedWal(swapped, a.se), bus: EventBus(), clock: clock.call).restore(), throwsA(isA<SwException>()));
    // 3) entrada de ledger en memoria alterada → verifyLocalLedger la detecta
    final e = a.agent.entries.first;
    final forged = LedgerEntry(seq: e.seq, counter: e.counter, prevHash: e.prevHash, keyEpoch: e.keyEpoch, type: e.type, payload: {...e.payload, 'usdMinor': 1}, hash: e.hash, mac: e.mac, sig: e.sig);
    expect(await _verifyList(a.agent, [forged, ...a.agent.entries.skip(1)]), 0);
  });

  test('restore(): el estado completo se reconstruye desde el WAL cifrado', () async {
    final a = await Phone.provisioned(auth, clock);
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 700, currency: 'PEN'));
    await a.agent.markReconciled(0);
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 800, currency: 'PEN'));
    final b = OfflineAgent(se: a.se, wal: a.wal, bus: EventBus(), clock: clock.call);
    await b.restore();
    expect(b.deviceId, a.id);
    expect(b.lastSeq, 1);
    expect(b.lastHash, a.agent.lastHash);
    expect(b.availableTokens, a.agent.availableTokens);
    expect(b.pendingEntries().map((e) => e.seq), [1]);
    expect(await b.verifyLocalLedger(), -1);
    // reutilizar un token ya usado es imposible tras reiniciar
    final art = await b.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN'));
    expect(art.entry.seq, 2);
  });

  test('congelado o con SE borrado: no firma nada', () async {
    final a = await Phone.provisioned(auth, clock);
    await a.agent.freeze('test');
    await expectLater(a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN')), throwsA(isA<DeviceFrozen>()));
    await a.agent.unfreeze();
    await a.se.wipe();
    await expectLater(a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN')), throwsA(isA<DeviceFrozen>()));
    expect(() => a.se.publicKey, throwsStateError);
  });

  test('el bus publica LedgerAppended por cada entrada', () async {
    final a = await Phone.provisioned(auth, clock);
    final seen = <int>[];
    a.bus.on<LedgerAppended>().listen((e) => seen.add(e.seq));
    await a.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN'));
    expect(seen, [0]);
  });

  test('SMS: payload comprimido y cifrado con la clave del SE; descifrable con la clave del servidor', () async {
    final a = await Phone.provisioned(auth, clock);
    final p = await a.agent.prepareSmsPayment(payeePhone: '+51999000222', amountMinor: 1800, currency: 'PEN');
    expect(p['t'], hasLength(12));
    expect(p['q'], hasLength(32));
    expect(a.agent.entries.last.type, 'NOTE');
  });
}

Future<RateSnapshot> _snap(Map<String, dynamic> s) async => RateSnapshot.fromJson(s);

Future<int> _verifyList(OfflineAgent agent, List<LedgerEntry> list) async {
  var prev = genesisHash;
  for (final e in list) {
    final base = {'seq': e.seq, 'counter': e.counter, 'prevHash': e.prevHash, 'keyEpoch': e.keyEpoch, 'type': e.type, 'payload': e.payload};
    final h = await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(canonicalJson(base)));
    if (e.prevHash != prev || e.hash != h) return e.seq;
    prev = e.hash;
  }
  return -1;
}
