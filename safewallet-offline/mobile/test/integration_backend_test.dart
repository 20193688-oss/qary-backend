// Prueba de integración REAL: agentes Dart ↔ backend TypeScript (PostgreSQL + Redis).
// Se ejecuta solo si SW_BACKEND_URL está definido:  SW_BACKEND_URL=http://localhost:3000 flutter test test/integration_backend_test.dart
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:safewallet_offline/app/app_controller.dart';
import 'package:safewallet_offline/core/crypto/crypto.dart';
import 'package:safewallet_offline/core/dual_agent/backend_api.dart';
import 'package:safewallet_offline/core/dual_agent/bus.dart';
import 'package:safewallet_offline/core/dual_agent/offline_agent.dart';
import 'package:safewallet_offline/core/dual_agent/online_agent.dart';
import 'package:safewallet_offline/core/dual_agent/wal.dart';
import 'package:safewallet_offline/core/integrity/integrity_guard.dart';
import 'package:safewallet_offline/core/models.dart';
import 'package:safewallet_offline/core/panic/forensic_log.dart';
import 'package:safewallet_offline/core/panic/shield.dart';
import 'package:safewallet_offline/core/panic/sms_gateway.dart';
import 'package:safewallet_offline/core/secure_element/secure_element.dart';
import 'package:safewallet_offline/features/ble_pay/secure_session.dart';
import 'package:safewallet_offline/features/ble_pay/transport.dart';
import 'package:safewallet_offline/features/qr_dynamic/qr_dynamic.dart';
import 'package:safewallet_offline/features/qr_interop/emv_qr.dart';
import 'package:safewallet_offline/features/sms_fallback/sms_fallback.dart';

class _Probe implements PlatformProbe {
  @override
  Future<bool> hasRootIndicators() async => false;
  @override
  Future<bool> looksLikeEmulator() async => false;
  @override
  Future<bool> hasHookingFramework() async => false;
  @override
  bool isDebuggable() => false;
  @override
  Future<String?> appSignatureSha256() async => null;
}

class Handset {
  Handset(this.se, this.wal, this.store, this.offline, this.online, this.bus, this.api);
  final SoftwareSecureElement se;
  final EncryptedWal wal;
  final MemoryBlobStore store;
  final OfflineAgent offline;
  final OnlineAgent online;
  final EventBus bus;
  final BackendApi api;
  String get id => offline.deviceId!;
}

Future<Handset> newHandset(BackendApi api, {required String phone, int tokens = 10}) async {
  final se = await SoftwareSecureElement.create();
  await se.generateSecret('wal');
  final store = MemoryBlobStore();
  final wal = EncryptedWal(store, se);
  final bus = EventBus();
  final offline = OfflineAgent(se: se, wal: wal, bus: bus);
  final online = OnlineAgent(api: api, offline: offline, bus: bus, guard: IntegrityGuard(probe: _Probe(), allowDebuggable: true));
  await online.register(buildId: 'it-build', appHash: 'it-hash');
  await online.configureProfile(
      phone: phone, pin: '1234', duressPin: '4321', email: 'it@example.com',
      contacts: [
        {'name': 'Mamá', 'phone': '+51999111000'}
      ],
      limits: const OfflineProfile(dailyLimitUsdMinor: 50000, perTxLimitUsdMinor: 20000));
  await online.tokenize(pan: '4111111111111111', expMonth: 12, expYear: 2030, count: tokens);
  return Handset(se, wal, store, offline, online, bus, api);
}

String phoneNo() => '+519${(DateTime.now().microsecondsSinceEpoch % 100000000).toString().padLeft(8, '0')}';
int _n = 0;
String uniquePhone() => '+51${9}${(DateTime.now().millisecondsSinceEpoch % 10000000).toString().padLeft(7, '0')}${_n++ % 10}';

void main() {
  final url = Platform.environment['SW_BACKEND_URL'];
  if (url == null) {
    test('integración con backend (omitida: define SW_BACKEND_URL)', () {}, skip: 'SW_BACKEND_URL no definido');
    return;
  }
  final api = HttpBackendApi(baseUrl: url, apiKey: Platform.environment['SW_API_KEY'] ?? 'sw_sandbox_demo_key');
  final admin = HttpBackendApi(baseUrl: url, apiKey: Platform.environment['SW_ADMIN_KEY'] ?? 'sw_admin_demo_key');
  Future<void> fund(Handset h, String cur, int amt) => api.request('POST', '/v1/devices/${h.id}/fund', {'currency': cur, 'amountMinor': amt});
  Future<Map<String, dynamic>> balances(Handset h) async => (await api.request('GET', '/v1/devices/${h.id}/wallet'))['balances'] as Map<String, dynamic>;
  Future<bool> yes(PaymentSummary s) async => true;

  test('onboarding → tokenización → tasas → pago BLE offline → conciliación al recuperar red', () async {
    final alice = await newHandset(api, phone: uniquePhone());
    final taxi = await newHandset(api, phone: uniquePhone(), tokens: 2);
    await fund(alice, 'PEN', 100000);
    expect(alice.offline.deviceId, hasLength(32));
    expect(alice.offline.availableTokens, 10);
    expect(alice.offline.rates!.latest, isNotNull);

    // --- sin red: pago por Bluetooth (loopback) con confirmación biométrica en ambos lados
    final (tp, tt) = LoopbackTransport.pair();
    final res = await Future.wait([
      SecureSession.runPayer(alice.offline, tp, yes),
      SecureSession.runPayee(taxi.offline, tt, amountMinor: 1200, currency: 'USD', confirm: yes),
    ]);
    expect(res[0]['txId'], res[1]['txId']);

    // --- recupera red: primero el taxista, luego Alice (idempotente)
    final events = <BusEvent>[];
    alice.bus.stream.listen(events.add);
    final rt = await taxi.online.onNetworkRecovered();
    expect(rt!.chainOk, isTrue);
    expect(rt.settled, 1);
    final ra = await alice.online.onNetworkRecovered();
    expect(ra!.chainOk, isTrue);
    expect(ra.results.map((x) => x['status']), ['duplicate']);
    expect(alice.offline.pendingEntries(), isEmpty);
    expect((await balances(taxi))['USD'], 1200);
    final aliceBal = (await balances(alice))['PEN'] as int;
    expect(aliceBal, inInclusiveRange(100000 - 4590, 100000 - 4500)); // pagó USD 12 a ~3.75 (el margen del 2 % se concilia a favor del usuario)
    expect(events.whereType<ReconcileFinished>(), isNotEmpty);
    // el segundo replay no cambia nada
    expect((await alice.online.reconcile()).accepted, 0);
  });

  test('doble gasto offline (dispositivo clonado): el replay se rechaza, se bloquea y se congela el ledger', () async {
    final alice = await newHandset(api, phone: uniquePhone());
    final shop1 = await newHandset(api, phone: uniquePhone(), tokens: 1);
    final shop2 = await newHandset(api, phone: uniquePhone(), tokens: 1);
    await fund(alice, 'PEN', 100000);
    // clon: mismo Secure Element + copia del WAL cifrado
    final cloneStore = MemoryBlobStore()..lines.addAll(await alice.store.readLines());
    final clone = OfflineAgent(se: alice.se, wal: EncryptedWal(cloneStore, alice.se), bus: EventBus());
    await clone.restore();
    final a1 = await alice.offline.createPayment(PaymentRequest(payeeDeviceId: shop1.id, amountMinor: 5000, currency: 'PEN'));
    final a2 = await clone.createPayment(PaymentRequest(payeeDeviceId: shop2.id, amountMinor: 5000, currency: 'PEN')); // mismo token y contador
    expect((a1.voucher['intent'] as Map)['token'], (a2.voucher['intent'] as Map)['token']);
    // ambos comercios están online y autorizan
    final r1 = await api.request('POST', '/v1/authorize-offline', a1.voucher);
    final r2 = await api.request('POST', '/v1/authorize-offline', a2.voucher);
    expect(r1['status'], 'settled');
    expect(r2['status'], 'declined');
    expect(['token_reuse', 'counter_reuse'], contains(r2['reason']));
    // el dispositivo queda bloqueado preventivamente y, al recuperar red, el agente online lo congela y avisa
    final detected = <BusEvent>[];
    alice.bus.on<DoubleSpendDetected>().listen(detected.add);
    final sum = await alice.online.reconcile();
    expect(sum.deviceStatus, 'locked');
    expect(alice.offline.frozen, isTrue);
    expect(detected, hasLength(1));
    await expectLater(alice.offline.createPayment(PaymentRequest(payeeDeviceId: shop1.id, amountMinor: 1, currency: 'PEN')), throwsA(isA<DeviceFrozen>()));
    final unlocked = await api.request('POST', '/v1/devices/${alice.id}/unlock', {'pin': '1234'});
    expect(unlocked['status'], 'active');
  });

  test('ledger manipulado en tránsito: el backend rechaza la cadena', () async {
    final alice = await newHandset(api, phone: uniquePhone());
    final shop = await newHandset(api, phone: uniquePhone(), tokens: 1);
    await fund(alice, 'PEN', 100000);
    await alice.offline.createPayment(PaymentRequest(payeeDeviceId: shop.id, amountMinor: 1000, currency: 'PEN'));
    final entries = alice.offline.pendingEntries().map((e) => e.toJson()).toList();
    ((entries.first['payload'] as Map)['voucher'] as Map)['intent']['amountMinor'] = 1;
    final r = await api.request('POST', '/v1/reconcile', {'deviceId': alice.id, 'entries': entries});
    expect(r['chainOk'], isFalse);
    expect(r['chainError'], 'hash_mismatch');
    expect(r['deviceStatus'], 'locked');
  });

  test('QR dinámico firmado, SMS cifrado y QR EMVCo (Yape) contra el backend', () async {
    final alice = await newHandset(api, phone: uniquePhone());
    final taxi = await newHandset(api, phone: uniquePhone(), tokens: 2);
    await fund(alice, 'PEN', 200000);
    final pub = alice.offline.serverPublicKey!;

    // --- QR dinámico: el taxista (con red) genera; Alice paga sin red; el taxista sube el voucher
    final q = await api.request('POST', '/v1/qr/dynamic', {'deviceId': taxi.id, 'amountMinor': 1500, 'currency': 'USD'});
    final qr = await DynamicQr.parseAndVerify(q['qr'] as String, pub, now: alice.offline.now());
    final art = await QrPaymentFlow(alice.offline).payScanned(qr);
    final back = QrPaymentFlow.parseResponseQr(QrPaymentFlow.responseQr(art.voucher));
    final r = await api.request('POST', '/v1/authorize-offline', back);
    expect(r['status'], 'settled');
    expect((await api.request('GET', '/v1/qr/${q['qrId']}'))['paid'], isTrue);
    expect((await balances(taxi))['USD'], 1500);

    // --- SMS: solo línea celular
    final gw = RecordingSmsGateway();
    final taxiPhone = (await api.request('PUT', '/v1/devices/${taxi.id}/profile', {}))['phone'] as String;
    final msg = await SmsPayment(alice.offline, gw).send('+51900000000', payeePhone: taxiPhone, amountMinor: 1800, currency: 'PEN');
    final inbound = await api.request('POST', '/v1/sms/inbound', {'from': '+51999999999', 'to': '+51900000000', 'body': msg});
    expect(inbound['kind'], 'payment');
    expect((inbound['result'] as Map)['status'], 'settled');
    expect((await balances(taxi))['PEN'], 1800);

    // --- EMVCo: Alice sin red genera voucher diferido; el taxista lo sube y el backend lo enruta (mock)
    final vectors = jsonDecode(File('test/vectors.json').readAsStringSync()) as Map<String, dynamic>;
    final emv = (vectors['emv'] as Map)['payload'] as String;
    final plan = await EmvPayer(alice.offline).plan(emv, online: false);
    final routed = await api.request('POST', '/v1/qr/emv/route', {'emvPayload': emv, 'voucher': plan.voucher});
    expect((routed['tx'] as Map)['status'], 'settled');
    expect((routed['gateway'] as Map)['status'], 'ACCEPTED');
    expect((routed['gateway'] as Map)['wallet'], 'yape');
  });

  test('Protocolo Escudo: botón sin red → cola firmada → backend; SMS a contactos; tokens revocados; riesgo 72 h', () async {
    final victim = await newHandset(api, phone: uniquePhone());
    await fund(victim, 'PEN', 50000);
    final sms = RecordingSmsGateway();
    final outbox = MemoryBlobStore();
    final forensic = ForensicLog(se: victim.se, wal: victim.wal, deviceId: victim.id);
    await forensic.append('incident', 'asalto con arma de fuego, celular y mochila');
    final shield = ShieldProtocol(
        offline: victim.offline, sms: sms, bus: victim.bus, contacts: const [TrustedContact('Mamá', '+51999111000')], outbox: outbox, forensic: forensic,
        locate: () async => const GeoPoint(-12.05, -77.04));
    final rep = await shield.activate(ShieldTrigger.button);
    expect(rep.elapsedMs, lessThan(3000));
    expect(victim.se.isWiped, isTrue);

    // --- horas después, con red: se entrega el pánico firmado que quedó en cola
    final sent = await shield.flushOutbox((req) async => await api.request('POST', '/v1/panic', req));
    expect(sent, 1);
    final st = await api.request('GET', '/v1/devices/${victim.id}');
    expect(st['status'], 'shielded');
    expect(st['pendingCommands'], containsAll(['SE_WIPE', 'FREEZE_LEDGER']));
    final outMsgs = (await api.request('POST', '/v1/outbox/${victim.id}/dispatch'))['messages'] as List;
    expect(outMsgs.where((m) => m['kind'] == 'sms'), isNotEmpty);
    final userRef = (await api.request('PUT', '/v1/devices/${victim.id}/profile', {}))['userRef'] as String;
    final flag = await api.request('GET', '/v1/risk-flags/$userRef');
    expect(flag['atRisk'], isTrue);
    expect(flag['expiresAt'] - flag['issuedAt'], 72 * 3600 * 1000);

    // --- los tokens ya no sirven: un voucher previo al robo queda congelado
    final tokens = await api.request('GET', '/v1/devices/${victim.id}/transactions');
    expect(tokens['transactions'], isEmpty);
  });

  test('Escudo remoto (SAFE-SOS por SMS): el agente online ejecuta SE_WIPE y FREEZE al recuperar red', () async {
    final h = await newHandset(api, phone: uniquePhone());
    final phone = (await api.request('PUT', '/v1/devices/${h.id}/profile', {}))['phone'] as String;
    // un tercero envía SAFE-SOS-<PIN> desde otro teléfono al número del usuario (llega al gateway SMS)
    final r = await api.request('POST', '/v1/sms/inbound', {'from': '+51911111111', 'to': phone, 'body': 'SAFE-SOS-1234'});
    expect(r['kind'], 'sos');
    final exec = await h.online.pollCommands();
    expect(exec, containsAll(['SE_WIPE', 'FREEZE_LEDGER']));
    expect(h.se.isWiped, isTrue);
    expect(h.offline.frozen, isTrue);
    expect((await api.request('GET', '/v1/devices/${h.id}'))['pendingCommands'], isEmpty);
  });

  test('auditoría forense y reportes firmados', () async {
    final h = await newHandset(api, phone: uniquePhone());
    final f = ForensicLog(se: h.se, wal: h.wal, deviceId: h.id);
    await f.append('incident', 'denuncia cifrada 1');
    await f.append('photo', 'sha256:deadbeef');
    await h.online.uploadForensic(f.pending());
    await f.markUploaded(1);
    final exp = await api.request('GET', '/v1/forensic/${h.id}/export');
    expect(exp['deviceChainOk'], isTrue);
    expect(exp['anchorsOk'], isTrue);
    expect(exp['count'], 2);
    for (final p in ['hourly', 'daily', 'weekly', 'monthly', 'yearly']) {
      final rep = await api.request('GET', '/v1/reports/${h.id}?period=$p');
      expect(rep['sig'], isNotEmpty);
    }
    await h.online.rotateKeys();
    expect(h.offline.keyEpoch, 2);
    final art = await h.offline.createPayment(PaymentRequest(payeeRef: 'emv:yape:1', amountMinor: 100, currency: 'PEN', extra: const {}));
    expect(art.entry.keyEpoch, 2);
  });

  test('app completa (AppController): onboarding → BLE/NFC/QR/EMV/SMS → sincronizar → pánico', () async {
    final sms = RecordingSmsGateway();
    final c = AppController(api: api, probe: _Probe(), sms: sms, buildId: 'it-build', appHash: 'it-hash');
    final ok = await c.onboard(
        apiUrl: url, apiKey: 'sw_sandbox_demo_key', phone: uniquePhone(), pin: '1234', duressPin: '4321', pan: '4111111111111111',
        contacts: const [TrustedContact('Mamá', '+51999111000')]);
    expect(ok, isTrue, reason: c.log.map((l) => l.text).join(' | '));
    expect(c.stage, Stage.ready);
    await c.topUpSandbox(500000);
    expect(c.balances['PEN'], 500000);
    await c.payNearby(amountMinor: 1200, currency: 'USD', nfc: false);
    await c.payNearby(amountMinor: 1500, currency: 'PEN', nfc: true);
    await c.payQr(amountMinor: 800, currency: 'USD');
    await c.payEmv(EmvQr.build(dynamic: true, guid: 'pe.com.yape', account: '999888777', currencyNumeric: '604', amount: '12.50', country: 'PE', name: 'TAXI LIMA', city: 'LIMA'), online: false);
    await c.paySms(payeePhone: '999000222', amountMinor: 1800);
    expect(c.log.where((l) => l.error), isEmpty, reason: c.log.where((l) => l.error).map((l) => l.text).join(' | '));
    await c.syncNow();
    expect(c.log.where((l) => l.error), isEmpty, reason: c.log.where((l) => l.error).map((l) => l.text).join(' | '));
    expect(c.offline!.pendingEntries(), isEmpty);
    expect(sms.sent.any((m) => m.body.startsWith('SWPAY1.')), isTrue);
    expect(c.balances['PEN'] as int, lessThan(500000));
    // pánico: sin red lo encola; al sincronizar se entrega
    await c.panic();
    expect(c.stage, Stage.shielded);
    expect(c.offline!.se.isWiped, isTrue);
    expect(sms.sent.any((m) => m.body.contains('[SafeWallet Escudo]')), isTrue);
    await c.syncNow();
    final st = await api.request('GET', '/v1/devices/${c.offline!.deviceId}');
    expect(st['status'], 'shielded');
  });

  test('dispositivo no confiable (Frida detectado) es rechazado por el backend', () async {
    final se = await SoftwareSecureElement.create();
    await se.generateSecret('wal');
    final bus = EventBus();
    final offline = OfflineAgent(se: se, wal: EncryptedWal(MemoryBlobStore(), se), bus: bus);
    final online = OnlineAgent(api: api, offline: offline, bus: bus, guard: IntegrityGuard(probe: _HookedProbe(), allowDebuggable: true));
    await expectLater(online.register(buildId: 'it-build', appHash: 'it-hash'), throwsA(predicate((e) => e is SwException && e.code == 'device_untrusted')));
  });

  test('sin red: error claro con contexto, nunca silencioso', () async {
    final dead = HttpBackendApi(baseUrl: 'http://127.0.0.1:1', apiKey: 'x', timeout: const Duration(seconds: 2));
    await expectLater(dead.request('GET', '/health'), throwsA(predicate((e) => e is SwException && e.code == 'network_unreachable' && e.message.contains('/health'))));
    admin.toString();
  });

  tearDownAll(() => SwCrypto.randomHex(1));
}

class _HookedProbe extends _Probe {
  @override
  Future<bool> hasHookingFramework() async => true;
}
