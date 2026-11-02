import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:safewallet_offline/app/app_controller.dart';
import 'package:safewallet_offline/app/screens.dart';
import 'package:safewallet_offline/core/dual_agent/bus.dart';
import 'package:safewallet_offline/core/dual_agent/offline_agent.dart';
import 'package:safewallet_offline/core/dual_agent/wal.dart';
import 'package:safewallet_offline/core/panic/pin_vault.dart';
import 'package:safewallet_offline/core/panic/shield.dart';
import 'package:safewallet_offline/core/panic/sms_gateway.dart';
import 'package:safewallet_offline/core/secure_element/secure_element.dart';

import 'support.dart';

void main() {
  testWidgets('onboarding valida PIN y teléfono antes de llamar al backend', (t) async {
    final c = AppController();
    await t.pumpWidget(SafeWalletApp(controller: c));
    await t.tap(find.byKey(const Key('activate')));
    await t.pump();
    expect(find.byKey(const Key('error')), findsOneWidget);
    expect(find.text('El PIN debe tener 4 a 8 dígitos'), findsOneWidget);
    await t.enterText(find.byKey(const Key('pin')), '1234');
    await t.enterText(find.byKey(const Key('duress')), '1234');
    await t.tap(find.byKey(const Key('activate')));
    await t.pump();
    expect(find.text('El PIN de coacción debe ser distinto del PIN real'), findsOneWidget);
    expect(c.log, isEmpty); // no se llegó a llamar al backend
  });

  testWidgets('botón de pánico (long-press) activa el Escudo y deshabilita pagos', (t) async {
    t.view.physicalSize = const Size(800, 2600);
    t.view.devicePixelRatio = 1.0;
    addTearDown(t.view.reset);
    final clock = TestClock();
    final auth = await TestAuthority.create(clock);
    final se = await SoftwareSecureElement.create();
    await se.generateSecret('wal');
    final bus = EventBus();
    final offline = OfflineAgent(se: se, wal: EncryptedWal(MemoryBlobStore(), se), bus: bus, clock: clock.call);
    await offline.applyAttestation(await auth.attestResponse(se));
    await offline.applyTokens(await auth.tokenizeResponse(se, offline.deviceId!));
    final sms = RecordingSmsGateway();
    final c = AppController(sms: sms);
    c.stage = Stage.ready;
    c.bus = bus;
    c.offline = offline;
    c.shield = ShieldProtocol(offline: offline, sms: sms, bus: bus, contacts: const [TrustedContact('Mamá', '+51999111000')], outbox: MemoryBlobStore(), clock: clock.call);
    c.balances = {'PEN': 123450};
    await t.pumpWidget(SafeWalletApp(controller: c));
    expect(find.text('PEN: 1234.50'), findsOneWidget);
    expect(find.byKey(const Key('pay-ble')), findsOneWidget);
    await t.longPress(find.byKey(const Key('panic')));
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 500))); // deja terminar la criptografía real (async)
    await t.pump();
    expect(find.byKey(const Key('shield-banner')), findsOneWidget);
    expect(find.byKey(const Key('pay-ble')), findsNothing);
    expect(sms.sent, hasLength(1));
    expect(se.isWiped, isTrue);
    expect(c.stage, Stage.shielded);
  });

  testWidgets('PIN de coacción: la pantalla sigue «normal» pero muestra saldos señuelo y alerta en silencio', (t) async {
    final clock = TestClock();
    final auth = await TestAuthority.create(clock);
    final se = await SoftwareSecureElement.create();
    await se.generateSecret('wal');
    final bus = EventBus();
    final wal = EncryptedWal(MemoryBlobStore(), se);
    final offline = OfflineAgent(se: se, wal: wal, bus: bus, clock: clock.call);
    await offline.applyAttestation(await auth.attestResponse(se));
    final sms = RecordingSmsGateway();
    final contacts = [const TrustedContact('Mamá', '+51999111000')];
    final c = AppController(sms: sms);
    c.stage = Stage.ready;
    c.bus = bus;
    c.offline = offline;
    final pins = PinVault(se: se, wal: wal, iterations: 1000);
    await pins.setPins('1234', '4321');
    c.pins = pins;
    c.shield = ShieldProtocol(offline: offline, sms: sms, bus: bus, contacts: contacts, outbox: MemoryBlobStore(), clock: clock.call);
    c.decoy = DecoyWallet(sms: sms, contacts: contacts, bus: bus, locate: null, clock: clock.call);
    c.balances = {'PEN': 500};
    await t.pumpWidget(SafeWalletApp(controller: c));
    await t.runAsync(() async {
      expect(await c.unlockWithPin('4321'), PinResult.duress);
    });
    await t.pump();
    expect(c.balances['PEN'], 184250); // saldo falso
    expect(c.stage, Stage.ready); // sin señales visibles de alarma
    expect(find.byKey(const Key('shield-banner')), findsNothing);
    await t.runAsync(() async => c.payDecoy(5000, 'PEN'));
    expect(c.decoy!.alerts, 1);
  });
}
