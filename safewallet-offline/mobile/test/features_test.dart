import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:safewallet_offline/core/crypto/canonical.dart';
import 'package:safewallet_offline/core/crypto/crypto.dart';
import 'package:safewallet_offline/core/models.dart';
import 'package:safewallet_offline/core/risk.dart';
import 'package:safewallet_offline/core/dual_agent/offline_agent.dart';
import 'package:safewallet_offline/features/multi_currency/fx.dart';
import 'package:safewallet_offline/features/qr_dynamic/qr_dynamic.dart';
import 'package:safewallet_offline/features/qr_interop/emv_qr.dart';
import 'package:safewallet_offline/features/sms_fallback/sms_fallback.dart';
import 'package:safewallet_offline/core/panic/sms_gateway.dart';

import 'support.dart';

void main() {
  _emvBuilderTest();
  final v = jsonDecode(File('test/vectors.json').readAsStringSync()) as Map<String, dynamic>;

  group('vectores cruzados TypeScript ↔ Dart', () {
    test('ARQC y entrada de ledger (hash, MAC) idénticos', () async {
      final a = v['arqc'] as Map<String, dynamic>;
      final i = a['input'] as Map<String, dynamic>;
      expect((await SwCrypto.hmacHex(SwCrypto.unhex(a['luk']), SwCrypto.utf8Bytes(canonicalJson(i)))).substring(0, 32), a['out']);
      final e = v['entry'] as Map<String, dynamic>;
      final h = await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(canonicalJson(e['base'])));
      expect(h, e['hash']);
      expect(await SwCrypto.hmacHex(SwCrypto.unhex(e['ledgerKey']), SwCrypto.utf8Bytes(h)), e['mac']);
    });

    test('FX: tasas cruzadas, precios con margen y conversión a USD', () {
      final fx = v['fx'] as Map<String, dynamic>;
      final snap = RateSnapshot(id: 'x', asOf: 0, expiresAt: 1, ratesMicros: (fx['ratesMicros'] as Map).map((k, x) => MapEntry(k as String, x as int)), marginBps: 200, source: 't', sig: '');
      for (final c in fx['cross'] as List) {
        expect(snap.crossRateMicros(c['src'], c['dst']), c['micros'], reason: '${c['src']}->${c['dst']}');
      }
      for (final p in fx['price'] as List) {
        expect(payerPriceMinor(p['dest'], p['rate'], p['margin']), p['price']);
        expect(fairPriceMinor(p['dest'], p['rate']), p['fair']);
      }
      for (final u in fx['usd'] as List) {
        expect(snap.toUsdMinor(u['currency'], u['minor']), u['usd']);
      }
    });

    test('score de riesgo idéntico al del backend', () {
      for (final c in v['risk'] as List) {
        expect(riskScore(RiskInput.fromJson(Map<String, dynamic>.from(c['input'] as Map))), c['score']);
      }
    });

    test('snapshot de tasas firmado por el servidor se verifica; alterado se rechaza', () async {
      final s = v['snapshot'] as Map<String, dynamic>;
      final snap = RateSnapshot.fromJson(Map<String, dynamic>.from(s['snapshot'] as Map));
      expect(await snap.verify(s['serverPublicKey']), isTrue);
      final tampered = RateSnapshot(id: snap.id, asOf: snap.asOf, expiresAt: snap.expiresAt, ratesMicros: {...snap.ratesMicros, 'PEN': 1}, marginBps: snap.marginBps, source: snap.source, sig: snap.sig);
      expect(await tampered.verify(s['serverPublicKey']), isFalse);
      final store = RateStore(s['serverPublicKey'], clock: () => 5000);
      await store.add(snap);
      expect(store.latest!.id, 'rs_vector');
      await expectLater(RateStore('A' * 87).add(snap), throwsA(isA<SwException>()));
    });

    test('QR dinámico: verifica la firma del servidor offline, detecta falsificación y expiración', () async {
      final q = v['qr'] as Map<String, dynamic>;
      final ok = await DynamicQr.parseAndVerify(q['qr'], q['serverPublicKey'], now: 1000);
      expect(ok.amountMinor, 1200);
      expect(ok.currency, 'USD');
      expect(ok.rates!.id, 'rs_vector');
      await expectLater(DynamicQr.parseAndVerify(q['qr'], q['serverPublicKey'], now: 4102444800001), throwsA(predicate((e) => e is SwException && e.code == 'qr_expired')));
      final obj = jsonDecode(utf8.decode(SwCrypto.unb64u((q['qr'] as String).substring(6)))) as Map<String, dynamic>;
      obj['p']['amountMinor'] = 1;
      final forged = 'SWQR1:${SwCrypto.b64u(utf8.encode(jsonEncode(obj)))}';
      await expectLater(DynamicQr.parseAndVerify(forged, q['serverPublicKey'], now: 1000), throwsA(predicate((e) => e is SwException && e.code == 'qr_bad_signature')));
      await expectLater(DynamicQr.parseAndVerify('hola', q['serverPublicKey'], now: 1), throwsA(isA<SwException>()));
    });

    test('EMVCo: parsea el mismo QR que el backend y detecta manipulación', () async {
      final e = v['emv'] as Map<String, dynamic>;
      final qr = await EmvQr.parse(e['payload']);
      final i = e['info'] as Map<String, dynamic>;
      expect(qr.wallet, i['wallet']);
      expect(qr.currency, i['currency']);
      expect(qr.amountMinor, i['amountMinor']);
      expect(qr.merchantName, i['merchantName']);
      expect(qr.accountId, i['accountId']);
      expect(qr.dynamic, i['dynamic']);
      expect(qr.emvHash, i['emvHash']);
      expect(EmvQr.crc16('123456789'), '29B1');
      await expectLater(EmvQr.parse((e['payload'] as String).replaceFirst('12.50', '99.50')), throwsA(predicate((x) => x is SwException && x.code == 'emv_crc_invalid')));
      await expectLater(EmvQr.parse('00020101'), throwsA(isA<SwException>()));
    });

    test('SMS SWPAY1: el cliente Dart descifra lo que cifró el backend', () async {
      final s = v['sms'] as Map<String, dynamic>;
      final p = await SmsPayment.decodeWithKey(SwCrypto.unhex(s['key']), s['message']);
      expect(p, s['payload']);
      await expectLater(SmsPayment.decodeWithKey(SwCrypto.randomBytes(32), s['message']), throwsA(anything));
    });
  });

  group('funciones de la app', () {
    late TestClock clock;
    late TestAuthority auth;
    setUp(() async {
      clock = TestClock();
      auth = await TestAuthority.create(clock);
    });

    test('QR dinámico: el cliente paga offline en su moneda con la tasa del QR y responde por QR', () async {
      final alice = await Phone.provisioned(auth, clock);
      final taxi = await Phone.provisioned(auth, clock);
      // el QR lo emite el backend del taxista: simulamos con la autoridad
      final snap = await auth.snapshot(id: 'rs_qr', override: {'PEN': 3800000});
      final body = {'v': 1, 'qrId': 'qr-abc', 'payeeDeviceId': taxi.id, 'amountMinor': 1500, 'currency': 'USD', 'rateSnapshotId': 'rs_qr', 'iat': clock.t, 'exp': clock.t + 300000};
      final sig = await SwCrypto.sign(auth.kp, SwCrypto.utf8Bytes(canonicalJson(body)));
      final qrStr = 'SWQR1:${SwCrypto.b64u(utf8.encode(jsonEncode({'p': {...body, 'rates': snap}, 's': sig})))}';
      final qr = await DynamicQr.parseAndVerify(qrStr, auth.publicKey, now: clock.t);
      final art = await QrPaymentFlow(alice.agent).payScanned(qr);
      final i = Map<String, dynamic>.from(art.voucher['intent'] as Map);
      expect(i['rateSnapshotId'], 'rs_qr');
      expect(i['nonce'], 'qr-abc');
      expect(i['channel'], 'qr');
      expect(i['payerAmountMinor'], payerPriceMinor(1500, RateSnapshot.fromJson(snap).crossRateMicros('PEN', 'USD'), 200)); // tasa pactada en el QR (PEN=3.80), no la precargada (3.75)
      final back = QrPaymentFlow.parseResponseQr(QrPaymentFlow.responseQr(art.voucher));
      expect(back['payerSig'], art.voucher['payerSig']);
      // el taxista verifica el voucher recibido
      final ok = await taxi.agent.verifyIncoming(back, alice.agent.certificate!, expectedAmountMinor: 1500, expectedCurrency: 'USD', expectedNonce: 'qr-abc');
      expect(ok['txId'], i['txId']);
    });

    test('QR EMVCo (Yape/Plin): con red → pasarela; sin red → voucher diferido firmado ligado al QR', () async {
      final alice = await Phone.provisioned(auth, clock);
      final payload = (v['emv'] as Map)['payload'] as String;
      final payer = EmvPayer(alice.agent);
      final offline = await payer.plan(payload, online: false);
      expect(offline.mode, 'deferred_voucher');
      final i = Map<String, dynamic>.from(offline.voucher!['intent'] as Map);
      expect(i['channel'], 'qr_emv');
      expect(i['payeeRef'], 'emv:yape:999888777');
      expect(i['emvHash'], offline.qr!.emvHash);
      expect(i['amountMinor'], 1250);
      expect((await payer.plan(payload, online: true)).mode, 'online_gateway');
      await expectLater(payer.plan(payload, online: false, amountMinor: 999), throwsA(predicate((e) => e is SwException && e.code == 'emv_amount_mismatch')));
    });

    test('SMS: compone SWPAY1 cifrado, cabe en ≤ 3 SMS y se envía por la línea celular', () async {
      final alice = await Phone.provisioned(auth, clock);
      final gw = RecordingSmsGateway();
      final msg = await SmsPayment(alice.agent, gw).send('+51900000001', payeePhone: '+51999000222', amountMinor: 1800, currency: 'PEN');
      expect(gw.sent.single.body, msg);
      expect(msg, startsWith('SWPAY1.${alice.id}.1.'));
      expect(SmsPayment.partsFor(msg), lessThanOrEqualTo(3));
      // el servidor (que conoce la clave SMS) lo descifra
      final p = await SmsPayment.decodeWithKey(auth.keys[alice.id]!['sms']!, msg);
      expect(p['a'], 1800);
      expect(p['to'], '+51999000222');
      expect(p['k'], hasLength(16));
      expect(auth.luks.containsKey(p['k']), isTrue);
      expect(normalizePhone('999 000 222'), '+51999000222');
      expect(normalizePhone('+34 612 345 678'), '+34612345678');
      expect(() => normalizePhone('abc'), throwsA(isA<SwException>()));
    });

    test('rotación de claves: tras applyRotatedKeys el ledger usa la nueva época', () async {
      final alice = await Phone.provisioned(auth, clock);
      final nk = SwCrypto.randomBytes(32), ns = SwCrypto.randomBytes(32);
      auth.keys[alice.id] = {'ledger': nk, 'sms': ns};
      final plain = canonicalJson({'epoch': 2, 'ledgerKey': SwCrypto.b64u(nk), 'smsKey': SwCrypto.b64u(ns)});
      await alice.agent.applyRotatedKeys({'epoch': 2, 'wrapped': await SwCrypto.wrapFor(alice.se.publicKey, utf8.encode(plain), 'sw-keys|${alice.id}|2')});
      final art = await alice.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 100, currency: 'PEN'));
      expect(art.entry.keyEpoch, 2);
      expect(art.entry.mac, await SwCrypto.hmacHex(nk, SwCrypto.utf8Bytes(art.entry.hash)));
    });
  });
}

void _emvBuilderTest() {
  test('EmvQr.build produce exactamente el mismo QR que el backend', () async {
    final v = jsonDecode(File('test/vectors.json').readAsStringSync()) as Map<String, dynamic>;
    final built = EmvQr.build(dynamic: true, guid: 'pe.com.yape', account: '999888777', currencyNumeric: '604', amount: '12.50', country: 'PE', name: 'TAXI LIMA', city: 'LIMA', reference: 'R1');
    expect(built, (v['emv'] as Map)['payload']);
    expect((await EmvQr.parse(built)).amountMinor, 1250);
  });
}
