import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:safewallet_offline/core/crypto/canonical.dart';
import 'package:safewallet_offline/core/crypto/crypto.dart';
import 'package:safewallet_offline/core/dual_agent/bus.dart';
import 'package:safewallet_offline/core/dual_agent/offline_agent.dart';
import 'package:safewallet_offline/core/dual_agent/wal.dart';
import 'package:safewallet_offline/core/integrity/integrity_guard.dart';
import 'package:safewallet_offline/core/models.dart';
import 'package:safewallet_offline/core/panic/forensic_log.dart';
import 'package:safewallet_offline/core/panic/pin_vault.dart';
import 'package:safewallet_offline/core/panic/shield.dart';
import 'package:safewallet_offline/core/panic/sms_gateway.dart';
import 'package:safewallet_offline/features/wallet_guard/wallet_guard.dart';

import 'support.dart';

class FakeProbe implements PlatformProbe {
  FakeProbe({this.root = false, this.emu = false, this.hook = false, this.debug = false, this.sig});
  bool root, emu, hook, debug;
  String? sig;
  @override
  Future<bool> hasRootIndicators() async => root;
  @override
  Future<bool> looksLikeEmulator() async => emu;
  @override
  Future<bool> hasHookingFramework() async => hook;
  @override
  bool isDebuggable() => debug;
  @override
  Future<String?> appSignatureSha256() async => sig;
}

void main() {
  late TestClock clock;
  late TestAuthority auth;
  late Phone alice;
  late RecordingSmsGateway sms;
  late MemoryBlobStore outbox;
  late ShieldProtocol shield;
  const contacts = [TrustedContact('Mamá', '+51999111000'), TrustedContact('Hermano', '+51999222000')];

  setUp(() async {
    clock = TestClock();
    auth = await TestAuthority.create(clock);
    alice = await Phone.provisioned(auth, clock);
    sms = RecordingSmsGateway();
    outbox = MemoryBlobStore();
    shield = ShieldProtocol(offline: alice.agent, sms: sms, bus: alice.bus, contacts: contacts, outbox: outbox, clock: clock.call, locate: () async => const GeoPoint(-12.0464, -77.0428));
  });

  group('Protocolo Escudo', () {
    test('botón: < 3 s, sin red: firma y encola pánico, congela, revoca, avisa por SMS y borra el SE', () async {
      final seen = <BusEvent>[];
      alice.bus.stream.listen(seen.add);
      final r = await shield.activate(ShieldTrigger.button);
      expect(r.elapsedMs, lessThan(3000));
      expect(r.steps, ['panic_signed_and_queued', 'ledger_frozen', 'tokens_revoked', 'contacts_notified:2', 'se_wiped']);
      expect(alice.agent.frozen, isTrue);
      expect(alice.agent.availableTokens, 0);
      expect(alice.se.isWiped, isTrue);
      expect(sms.sent.map((m) => m.to), ['+51999111000', '+51999222000']);
      expect(sms.sent.first.body, contains('no soy yo quien pide dinero'));
      expect(sms.sent.first.body, contains('maps.google.com/?q=-12.0464,-77.0428'));
      expect(sms.sent.first.body, contains('ref:'));
      expect(seen.whereType<ShieldActivated>(), isNotEmpty);
      // tras el wipe nada se puede firmar
      await expectLater(alice.agent.createPayment(const PaymentRequest(payeeRef: 'x', amountMinor: 1, currency: 'PEN')), throwsA(isA<DeviceFrozen>()));
    });

    test('el pánico firmado queda en cola y es aceptable por el backend (formato de /v1/panic)', () async {
      await shield.activate(ShieldTrigger.button);
      final line = jsonDecode((await outbox.readLines()).single) as Map<String, dynamic>;
      expect(line['trigger'], 'button');
      expect(line['deviceId'], alice.id);
      expect(await SwCrypto.verify(alice.agent.certificate!.publicKey, SwCrypto.utf8Bytes(canonicalJson({'op': 'panic', 'deviceId': alice.id, 'ts': line['ts'], 'trigger': 'button'})), line['signature'] as String), isTrue);
      final sent = <Map<String, dynamic>>[];
      expect(await shield.flushOutbox((r) async => sent.add(r)), 1);
      expect(await outbox.readLines(), isEmpty);
      expect(sent.single['signature'], line['signature']);
    });

    test('si el envío al backend falla, el pánico permanece en cola (no se pierde en silencio)', () async {
      await shield.activate(ShieldTrigger.button);
      final errors = <BusEvent>[];
      alice.bus.on<AgentError>().listen(errors.add);
      expect(await shield.flushOutbox((r) async => throw SwException('network_unreachable', 'sin red')), 0);
      expect(await outbox.readLines(), hasLength(1));
      expect(errors, isNotEmpty);
    });

    test('un fallo de SMS no detiene el Escudo y se reporta', () async {
      final bad = _FailingSms();
      final s = ShieldProtocol(offline: alice.agent, sms: bad, bus: alice.bus, contacts: contacts, outbox: outbox, clock: clock.call);
      final errs = <BusEvent>[];
      alice.bus.on<AgentError>().listen(errs.add);
      final r = await s.activate(ShieldTrigger.button);
      expect(r.notified, 0);
      expect(alice.se.isWiped, isTrue);
      expect(errs, hasLength(2));
    });

    test('sin GPS (desactivado por el atacante) el Escudo igual se activa', () async {
      final s = ShieldProtocol(offline: alice.agent, sms: sms, bus: alice.bus, contacts: contacts, outbox: outbox, clock: clock.call, locate: () async => throw StateError('GPS off'));
      final r = await s.activate(ShieldTrigger.button);
      expect(r.steps, contains('se_wiped'));
      expect(sms.sent.first.body, isNot(contains('maps.google')));
    });
  });

  group('PIN de coacción, señuelo y SOS por SMS', () {
    late PinVault pins;
    setUp(() async {
      pins = PinVault(se: alice.se, wal: alice.wal, clock: clock.call, iterations: 1000);
      await pins.setPins('1234', '4321');
    });

    test('PIN real, de coacción, incorrecto y bloqueo tras 5 fallos', () async {
      expect(await pins.verify('1234'), PinResult.real);
      expect(await pins.verify('4321'), PinResult.duress);
      for (var i = 0; i < 5; i++) {
        expect(await pins.verify('0000'), PinResult.wrong);
      }
      expect(await pins.verify('1234'), PinResult.locked);
      clock.t += 16 * 60 * 1000;
      expect(await pins.verify('1234'), PinResult.real);
      await expectLater(pins.setPins('1111', '1111'), throwsA(isA<SwException>()));
    });

    test('el estado de bloqueo sobrevive a un reinicio (WAL)', () async {
      for (var i = 0; i < 5; i++) {
        await pins.verify('0000');
      }
      final again = PinVault(se: alice.se, wal: alice.wal, clock: clock.call, iterations: 1000);
      await again.restore();
      expect(await again.verify('1234'), PinResult.locked);
    });

    test('billetera señuelo: pago «exitoso» falso + alerta silenciosa a contactos (una por ventana de 5 min)', () async {
      final decoy = DecoyWallet(sms: sms, contacts: contacts, bus: alice.bus, locate: () async => const GeoPoint(-12.1, -77.1), clock: clock.call);
      final alerts = <BusEvent>[];
      alice.bus.on<SilentAlert>().listen(alerts.add);
      final ref = await decoy.attemptPayment(5000, 'PEN');
      expect(ref, startsWith('ok-'));
      await decoy.attemptPayment(5000, 'PEN');
      expect(decoy.alerts, 1);
      expect(sms.sent, hasLength(2));
      expect(sms.sent.first.body, contains('bajo coacción'));
      expect(alerts, hasLength(2));
      clock.t += 6 * 60 * 1000;
      await decoy.attemptPayment(1, 'PEN');
      expect(decoy.alerts, 2);
    });

    test('Wallet Guard + PIN de coacción: el pago parece exitoso pero no mueve dinero y alerta en silencio', () async {
      final decoy = DecoyWallet(sms: sms, contacts: contacts, bus: alice.bus, locate: null, clock: clock.call);
      final guard = WalletGuard(offline: alice.agent, integrity: IntegrityGuard(probe: FakeProbe(), allowDebuggable: true), shield: shield, decoy: decoy);
      expect(await pins.verify('4321'), PinResult.duress);
      await shield.activate(ShieldTrigger.duressPin, pin: '4321'); // silencioso
      final d = await guard.intercept(const PayRequest(wallet: 'safewallet', amountMinor: 900, currency: 'PEN'));
      expect(d.allowed, isTrue);
      expect(d.reason, 'decoy');
      expect(d.voucher, isNull);
      expect(d.silentAlert, isTrue);
      expect(alice.agent.entries, isEmpty);
    });

    test('SAFE-SOS-<PIN> por SMS desde cualquier teléfono activa el Escudo; PIN erróneo no revela nada', () async {
      final handler = SosSmsHandler(pins: pins, shield: shield);
      expect(await handler.handleIncoming('+51900000000', 'hola'), isNull);
      expect(await handler.handleIncoming('+51900000000', 'SAFE-SOS-9999'), isNull);
      expect(shield.active, isFalse);
      final r = await handler.handleIncoming('+51911111111', ' safe-sos-1234 ');
      expect(r, isNotNull);
      expect(shield.active, isTrue);
      expect(alice.se.isWiped, isTrue);
    });
  });

  group('testamento digital, geofencing, forense', () {
    test('sin prueba de vida en X horas se activa el Escudo; con check-in no', () async {
      final dm = DeadManSwitch(hours: 24, shield: shield, clock: clock.call);
      clock.t += 20 * 3600 * 1000;
      expect(await dm.evaluate(), isNull);
      dm.checkIn();
      clock.t += 20 * 3600 * 1000;
      expect(await dm.evaluate(), isNull);
      clock.t += 5 * 3600 * 1000;
      final r = await dm.evaluate();
      expect(r?.trigger, ShieldTrigger.deadman);
      expect(shield.active, isTrue);
    });

    test('geofence: fuera de la zona segura sin biometría congela el ledger', () async {
      final g = Geofence(center: const GeoPoint(-12.0464, -77.0428), radiusM: 5000, offline: alice.agent);
      expect(await g.evaluate(const GeoPoint(-12.05, -77.04), biometricRecent: false), isTrue);
      expect(await g.evaluate(const GeoPoint(-12.5, -76.5), biometricRecent: true), isFalse);
      expect(alice.agent.frozen, isFalse);
      expect(await g.evaluate(const GeoPoint(-12.5, -76.5), biometricRecent: false), isFalse);
      expect(alice.agent.frozen, isTrue);
      expect(alice.agent.frozenReason, 'geofence_breach');
    });

    test('cadena de custodia forense: cifrada, encadenada y firmada; lista para /v1/forensic', () async {
      final f = ForensicLog(se: alice.se, wal: alice.wal, deviceId: alice.id, clock: clock.call);
      final e0 = await f.append('incident', 'robo a mano armada en Av. Arequipa');
      final e1 = await f.append('photo', 'sha256:abc');
      expect(e1['prevHash'], e0['hash']);
      expect(await f.open(0), 'robo a mano armada en Av. Arequipa');
      for (final e in f.entries) {
        final h = await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(canonicalJson({'deviceId': alice.id, 'index': e['index'], 'type': e['type'], 'ts': e['ts'], 'ciphertext': e['ciphertext'], 'prevHash': e['prevHash']})));
        expect(h, e['hash']);
        expect(await SwCrypto.verify(alice.se.publicKey, SwCrypto.utf8Bytes(h), e['sig'] as String), isTrue);
      }
      expect(e0['ciphertext'].toString(), isNot(contains('Arequipa')));
      await f.markUploaded(1);
      expect(f.pending(), isEmpty);
      final re = ForensicLog(se: alice.se, wal: alice.wal, deviceId: alice.id);
      await re.restore();
      expect(re.entries, hasLength(2));
      expect(re.uploadedUpTo, 1);
    });
  });

  group('anti-reversa / integridad', () {
    test('entorno limpio es confiable; root/emulador/Frida/debug/firma distinta bloquean', () async {
      expect((await IntegrityGuard(probe: FakeProbe(), allowDebuggable: true).evaluate()).trusted, isTrue);
      for (final p in [FakeProbe(root: true), FakeProbe(emu: true), FakeProbe(hook: true), FakeProbe(debug: true)]) {
        final r = await IntegrityGuard(probe: p).evaluate();
        expect(r.trusted, isFalse, reason: r.reasons.join());
      }
      final tampered = await IntegrityGuard(probe: FakeProbe(sig: 'AA'), expectedSignatureSha256: 'BB', allowDebuggable: true).evaluate();
      expect(tampered.tampered, isTrue);
      expect(tampered.reasons, contains('signature_mismatch'));
      final strict = await IntegrityGuard(probe: FakeProbe(), expectedSignatureSha256: 'BB', requireSignature: true, allowDebuggable: true).evaluate();
      expect(strict.tampered, isTrue); // en producción, no poder verificar la firma = no confiable
      await expectLater(IntegrityGuard(probe: FakeProbe(hook: true), allowDebuggable: true).requireTrusted(), throwsStateError);
    });

    test('detección real de Frida: puerto 27042 abierto y librerías en /proc/self/maps', () async {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      expect(await DefaultPlatformProbe(fridaPorts: [server.port]).hasHookingFramework(), isTrue);
      final dir = await Directory.systemTemp.createTemp('sw_maps');
      addTearDown(() => dir.delete(recursive: true));
      final clean = File('${dir.path}/maps_clean')..writeAsStringSync('7f00 r-xp libc.so\n7f10 r-xp libflutter.so\n');
      final dirty = File('${dir.path}/maps_dirty')..writeAsStringSync('7f00 r-xp libc.so\n7f20 r-xp /data/local/tmp/frida-agent-64.so\n');
      expect(await DefaultPlatformProbe(fridaPorts: const [1], mapsPath: clean.path).hasHookingFramework(), isFalse);
      expect(await DefaultPlatformProbe(fridaPorts: const [1], mapsPath: dirty.path).hasHookingFramework(), isTrue);
      final su = File('${dir.path}/su')..writeAsStringSync('');
      expect(await DefaultPlatformProbe(extraRootPaths: [su.path]).hasRootIndicators(), isTrue);
    });

    test('Wallet Guard bloquea pagos en entorno no confiable y con Escudo activo', () async {
      var guard = WalletGuard(offline: alice.agent, integrity: IntegrityGuard(probe: FakeProbe(hook: true), allowDebuggable: true), shield: shield);
      var d = await guard.intercept(const PayRequest(wallet: 'google_pay', amountMinor: 100, currency: 'PEN'));
      expect(d.allowed, isFalse);
      expect(d.reason, contains('hooking_framework'));
      guard = WalletGuard(offline: alice.agent, integrity: IntegrityGuard(probe: FakeProbe(), allowDebuggable: true), shield: shield);
      d = await guard.intercept(const PayRequest(wallet: 'apple_pay', amountMinor: 100, currency: 'PEN', payeeRef: 'pos:x'));
      expect(d.allowed, isTrue);
      expect(d.voucher, isNotNull);
      final sim = WalletSimulator(guard);
      final small = await sim.tapToPay('google_pay', amountMinor: 200, currency: 'PEN', merchantRef: 'bodega');
      expect(small.allowed, isTrue);
      final tap = await sim.tapToPay('google_pay', amountMinor: 30000, currency: 'PEN', merchantRef: 'bodega'); // ~USD 80 > límite reducido (USD 25) de comercio no listado
      expect(tap.allowed, isFalse);
      expect(tap.reason, startsWith('offline_limit'));
    });

    test('Wallet Guard: tras el Escudo ningún token/criptograma se libera', () async {
      final guard = WalletGuard(offline: alice.agent, integrity: IntegrityGuard(probe: FakeProbe(), allowDebuggable: true), shield: shield);
      await shield.activate(ShieldTrigger.button);
      final d = await guard.intercept(const PayRequest(wallet: 'google_pay', amountMinor: 100, currency: 'PEN', payeeRef: 'x'));
      expect(d.allowed, isFalse);
      expect(d.reason, 'shield_active');
    });

    test('biometría continua: detecta cadencia de tecleo distinta a la del propietario', () {
      final m = BehaviorMonitor();
      var t = 0;
      for (var i = 0; i < 60; i++) {
        t += 180 + (i % 5) * 10; // propietario: ~200 ms entre teclas
        m.recordKeyDown(t, calibrating: true);
      }
      m.resetSession();
      for (var i = 0; i < 15; i++) {
        t += 180 + (i % 5) * 10;
        m.recordKeyDown(t);
      }
      expect(m.isAnomalous, isFalse);
      final other = BehaviorMonitor();
      t = 0;
      for (var i = 0; i < 60; i++) {
        t += 180 + (i % 5) * 10;
        other.recordKeyDown(t, calibrating: true);
      }
      other.resetSession();
      for (var i = 0; i < 15; i++) {
        t += 520 + (i % 3) * 20; // otra persona: mucho más lenta
        other.recordKeyDown(t);
      }
      expect(other.isAnomalous, isTrue);
    });
  });
}

class _FailingSms implements SmsGateway {
  @override
  Future<void> send(String to, String body) async => throw StateError('sin señal');
}
