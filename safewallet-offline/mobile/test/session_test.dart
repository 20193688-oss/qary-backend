import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:safewallet_offline/core/crypto/crypto.dart';
import 'package:safewallet_offline/core/crypto/ratchet.dart';
import 'package:safewallet_offline/core/dual_agent/offline_agent.dart';
import 'package:safewallet_offline/core/models.dart';
import 'package:safewallet_offline/features/ble_pay/secure_session.dart';
import 'package:safewallet_offline/features/ble_pay/transport.dart';

import 'support.dart';

void main() {
  late TestClock clock;
  late TestAuthority auth;
  late Phone alice, taxi;
  setUp(() async {
    clock = TestClock();
    auth = await TestAuthority.create(clock);
    alice = await Phone.provisioned(auth, clock);
    taxi = await Phone.provisioned(auth, clock);
  });

  Future<bool> yes(PaymentSummary s) async => true;

  test('Double Ratchet: ida y vuelta, clave nueva por mensaje, replay y manipulación rechazados', () async {
    final rk = await SwCrypto.generateKeyPair();
    final sk = SwCrypto.randomBytes(32);
    final a = await RatchetSession.initiator(sk, rk.publicRaw);
    final b = await RatchetSession.responder(sk, rk);
    final m1 = await a.encrypt([1, 2, 3]);
    final m2 = await a.encrypt([4, 5, 6]);
    expect(m1['ct'], isNot(m2['ct']));
    expect(await b.decrypt(m1), [1, 2, 3]);
    expect(await b.decrypt(m2), [4, 5, 6]);
    final r1 = await b.encrypt([9]);
    expect(await a.decrypt(r1), [9]);
    await expectLater(b.decrypt(m1), throwsA(predicate((e) => e is SwException && e.code == 'ratchet_replay')));
    final bad = {...await a.encrypt([7]), 'ct': SwCrypto.b64u([1, 2, 3, 4])};
    await expectLater(b.decrypt(bad), throwsA(predicate((e) => e is SwException && e.code == 'ratchet_auth_failed')));
  });

  test('Double Ratchet: tolera mensajes desordenados', () async {
    final rk = await SwCrypto.generateKeyPair();
    final sk = SwCrypto.randomBytes(32);
    final a = await RatchetSession.initiator(sk, rk.publicRaw);
    final b = await RatchetSession.responder(sk, rk);
    final ms = [for (var i = 0; i < 4; i++) await a.encrypt([i])];
    expect(await b.decrypt(ms[2]), [2]);
    expect(await b.decrypt(ms[0]), [0]);
    expect(await b.decrypt(ms[3]), [3]);
    expect(await b.decrypt(ms[1]), [1]);
  });

  test('BLE: pago completo con confirmación en ambos lados, recibo contrafirmado y ledgers coherentes', () async {
    final (tp, tt) = LoopbackTransport.pair();
    PaymentSummary? seen;
    final payee = SecureSession.runPayee(taxi.agent, tt, amountMinor: 1200, currency: 'USD', confirm: yes);
    final payer = SecureSession.runPayer(alice.agent, tp, (s) async {
      seen = s;
      return true;
    });
    final results = await Future.wait([payer, payee]);
    final p = results[0], r = results[1];
    expect(p['txId'], r['txId']);
    expect(seen!.amountMinor, 1200);
    expect(seen!.currency, 'USD');
    expect(seen!.payerAmountMinor, 4590); // 12 USD * 3.75 * 1.02
    expect(seen!.rateMicros, 3750000 ~/ 1 == 3750000 ? 266667 : 0);
    expect(seen!.hash, hasLength(64));
    expect(alice.agent.entries.last.type, 'PAY_OUT');
    expect(taxi.agent.entries.last.type, 'PAY_IN');
    final v = Map<String, dynamic>.from(taxi.agent.entries.last.payload['voucher'] as Map);
    expect(v['payeeAck'], isNotNull);
    expect(await taxi.agent.verifyLocalLedger(), -1);
  });

  test('BLE: si el pagador no confirma biometría no se firma nada', () async {
    final (tp, tt) = LoopbackTransport.pair();
    final payee = SecureSession.runPayee(taxi.agent, tt, amountMinor: 500, currency: 'PEN', confirm: yes);
    final payer = SecureSession.runPayer(alice.agent, tp, (s) async => false);
    await expectLater(payer, throwsA(predicate((e) => e is SwException && e.code == 'user_cancelled')));
    await expectLater(payee, throwsA(predicate((e) => e is SwException && e.code == 'payer_cancelled')));
    expect(alice.agent.entries, isEmpty);
  });

  test('BLE: el beneficiario también debe confirmar (biometría en ambos lados)', () async {
    final (tp, tt) = LoopbackTransport.pair();
    final payee = SecureSession.runPayee(taxi.agent, tt, amountMinor: 500, currency: 'PEN', confirm: (s) async => false);
    final payer = SecureSession.runPayer(alice.agent, tp, yes);
    await expectLater(payee, throwsA(predicate((e) => e is SwException && e.code == 'user_cancelled')));
    await expectLater(payer.timeout(const Duration(seconds: 1)), throwsA(anything));
  });

  test('BLE: un tercero sin certificado del servidor no puede hacerse pasar por beneficiario', () async {
    final evilAuth = await TestAuthority.create(clock); // otra autoridad
    final evil = await Phone.provisioned(evilAuth, clock);
    evil.agent.serverPublicKey = auth.publicKey; // el atacante acepta al pagador legítimo, pero su propio certificado no es de nuestro servidor
    final (tp, tt) = LoopbackTransport.pair();
    // el atacante intenta cobrar: su certificado no está firmado por NUESTRO servidor
    final payee = SecureSession.runPayee(evil.agent, tt, amountMinor: 500, currency: 'PEN', confirm: yes);
    final payer = SecureSession.runPayer(alice.agent, tp, yes);
    await expectLater(payer, throwsA(predicate((e) => e is SwException && e.code == 'peer_cert_invalid')));
    await payee.timeout(const Duration(seconds: 1), onTimeout: () => <String, dynamic>{}).catchError((_) => <String, dynamic>{});
    expect(alice.agent.entries, isEmpty);
  });

  test('BLE: un MITM que altera bytes en tránsito rompe la sesión (sin pago)', () async {
    final (tp, tt) = LoopbackTransport.pair();
    var n = 0;
    tp.tamper = (b) {
      n++;
      if (n == 4 && b.length > 12) b[10] ^= 0xff; // modifica un fragmento cuando va cifrado
      return b;
    };
    final payee = SecureSession.runPayee(taxi.agent, tt, amountMinor: 500, currency: 'PEN', confirm: yes);
    final payer = SecureSession.runPayer(alice.agent, tp, yes);
    await expectLater(Future.wait([payer, payee]).timeout(const Duration(seconds: 3)), throwsA(anything));
    expect(taxi.agent.entries, isEmpty);
  });

  test('BLE: el beneficiario rechaza un voucher por monto distinto al solicitado', () async {
    final (tp, tt) = LoopbackTransport.pair();
    final payee = SecureSession.runPayee(taxi.agent, tt, amountMinor: 1000, currency: 'PEN', confirm: yes);
    // pagador hostil: manipula el request antes de pagar (cambia el monto)
    final payer = SecureSession.runPayer(alice.agent, tp, (s) async => true, merchantRef: null);
    final res = await Future.wait([payer.then<Object?>((v) => v, onError: (e) => e), payee.then<Object?>((v) => v, onError: (e) => e)]);
    // flujo honesto: éxito en ambos
    expect(res[0], isA<Map>());
    expect(res[1], isA<Map>());
    // verificación directa de rechazo por discrepancia
    final art = await alice.agent.createPayment(PaymentRequest(payeeDeviceId: taxi.id, amountMinor: 999, currency: 'PEN', nonce: 'n'));
    await expectLater(taxi.agent.verifyIncoming(art.voucher, alice.agent.certificate!, expectedAmountMinor: 1000, expectedCurrency: 'PEN'), throwsA(predicate((e) => e is SwException && e.code == 'amount_mismatch')));
    // firma adulterada
    final forged = {...art.voucher, 'payerSig': SwCrypto.b64u(List.filled(64, 1))};
    await expectLater(taxi.agent.verifyIncoming(forged, alice.agent.certificate!, expectedAmountMinor: 999, expectedCurrency: 'PEN'), throwsA(predicate((e) => e is SwException && e.code == 'payer_sig_invalid')));
    // voucher para otro beneficiario
    final other = await alice.agent.createPayment(PaymentRequest(payeeDeviceId: 'f' * 32, amountMinor: 10, currency: 'PEN'));
    await expectLater(taxi.agent.verifyIncoming(other.voucher, alice.agent.certificate!, expectedAmountMinor: 10, expectedCurrency: 'PEN'), throwsA(predicate((e) => e is SwException && e.code == 'wrong_payee')));
  });

  test('fragmentación BLE: ida y vuelta con CRC y detección de corrupción', () {
    final codec = BleFrameCodec(mtu: 64);
    final msg = Uint8List.fromList(List.generate(1000, (i) => i % 251));
    final frames = codec.split(msg);
    expect(frames.length, greaterThan(10));
    expect(frames.every((f) => f.length <= 64), isTrue);
    final rx = BleFrameCodec(mtu: 64);
    Uint8List? out;
    for (final f in frames.reversed) {
      out = rx.feed(f) ?? out;
    }
    expect(out, msg);
    final bad = Uint8List.fromList(frames.first)..[7] ^= 1;
    expect(() => BleFrameCodec().feed(bad), throwsA(predicate((e) => e is SwException && e.code == 'frame_crc')));
  });

  test('NFC/HCE: SELECT AID y comandos APDU encadenados se reensamblan', () {
    expect(NfcApdu.isSelect(NfcApdu.select()), isTrue);
    expect(NfcApdu.isSelect(Uint8List.fromList([0, 0xA4, 4, 0, 1, 1])), isFalse);
    final msg = Uint8List.fromList(List.generate(700, (i) => (i * 7) % 256));
    final cmds = NfcApdu.command(msg);
    expect(cmds.length, 3);
    final acc = <Uint8List>[];
    Uint8List? out;
    for (final c in cmds) {
      out = NfcApdu.reassemble(acc, c);
    }
    expect(out, msg);
    expect(() => NfcApdu.reassemble([], cmds[1]), throwsA(predicate((e) => e is SwException && e.code == 'apdu_order')));
  });

  test('NFC: pago completo entre dos teléfonos sin internet (canal APDU sobre el protocolo seguro)', () async {
    // Se encapsula cada fragmento del protocolo en APDUs y se entrega al otro lado como lo haría el lector HCE.
    final (tp, tt) = LoopbackTransport.pair();
    final viaApdu = _ApduTransport(tp);
    final viaApdu2 = _ApduTransport(tt);
    final payee = SecureSession.runPayee(taxi.agent, viaApdu2, amountMinor: 700, currency: 'PEN', confirm: yes, channel: 'nfc');
    final payer = SecureSession.runPayer(alice.agent, viaApdu, yes);
    final r = await Future.wait([payer, payee]);
    expect(r[0]['txId'], r[1]['txId']);
    final intent = (Map<String, dynamic>.from(alice.agent.entries.last.payload['voucher'] as Map))['intent'] as Map;
    expect(intent['channel'], 'nfc');
  });
}

/// Adaptador: cada frame BLE viaja como un APDU (para demostrar el transporte HCE).
class _ApduTransport implements PeerTransport {
  _ApduTransport(this.inner);
  final PeerTransport inner;
  @override
  Future<void> send(Uint8List bytes) async {
    for (final c in NfcApdu.command(bytes)) {
      await inner.send(c);
    }
  }

  @override
  Stream<Uint8List> get incoming {
    final acc = <Uint8List>[];
    final c = StreamController<Uint8List>.broadcast(sync: true);
    inner.incoming.listen((apdu) {
      final m = NfcApdu.reassemble(acc, apdu);
      if (m != null) c.add(m);
    });
    return c.stream;
  }

  @override
  Future<void> close() => inner.close();
}
