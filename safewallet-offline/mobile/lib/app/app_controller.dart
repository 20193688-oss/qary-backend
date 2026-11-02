import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/dual_agent/backend_api.dart';
import '../core/dual_agent/bus.dart';
import '../core/dual_agent/offline_agent.dart';
import '../core/dual_agent/online_agent.dart';
import '../core/dual_agent/wal.dart';
import '../core/integrity/integrity_guard.dart';
import '../core/models.dart';
import '../core/panic/forensic_log.dart';
import '../core/panic/pin_vault.dart';
import '../core/panic/shield.dart';
import '../core/panic/sms_gateway.dart';
import '../core/secure_element/secure_element.dart';
import '../features/ble_pay/secure_session.dart';
import '../features/ble_pay/transport.dart';
import '../features/qr_dynamic/qr_dynamic.dart';
import '../features/qr_interop/emv_qr.dart';
import '../features/sms_fallback/sms_fallback.dart';

enum Stage { onboarding, ready, shielded }

class LogLine {
  LogLine(this.text, {this.error = false}) : at = DateTime.now();
  final String text;
  final bool error;
  final DateTime at;
}

/// Controlador de la app: orquesta los dos agentes, el Escudo y los canales de pago.
/// Todo error se registra con contexto y se muestra al usuario (nunca se traga en silencio).
class AppController extends ChangeNotifier {
  AppController({BackendApi? api, PlatformProbe? probe, SmsGateway? sms, this.buildId = BuildWatermark.buildId, this.appHash = BuildWatermark.appHash})
      : _api = api,
        probe = probe ?? DefaultPlatformProbe(),
        sms = sms ?? RecordingSmsGateway();

  BackendApi? _api;
  final PlatformProbe probe;
  final SmsGateway sms;
  final String buildId, appHash;

  Stage stage = Stage.onboarding;
  final List<LogLine> log = [];
  bool busy = false;
  Map<String, dynamic> balances = {};

  late SoftwareSecureElement _se;
  late EncryptedWal _wal;
  late EventBus bus;
  OfflineAgent? offline;
  OnlineAgent? online;
  ShieldProtocol? shield;
  PinVault? pins;
  ForensicLog? forensic;
  DecoyWallet? decoy;
  _Virtual? _taxi; // segundo teléfono virtual para la demo en un solo dispositivo
  final MemoryBlobStore _outbox = MemoryBlobStore();

  /// Registra un mensaje visible para el usuario.
  void note(String t, {bool error = false}) => _add(t, error: error);

  void _add(String t, {bool error = false}) {
    log.insert(0, LogLine(t, error: error));
    notifyListeners();
  }

  Future<T?> _guard<T>(String what, Future<T> Function() f) async {
    busy = true;
    notifyListeners();
    try {
      return await f();
    } on SwException catch (e) {
      _add('$what: ${e.message} [${e.code}]', error: true);
    } catch (e, st) {
      debugPrint('ERROR $what: $e\n$st');
      _add('$what: error inesperado: $e', error: true);
    } finally {
      busy = false;
      notifyListeners();
    }
    return null;
  }

  /// Onboarding: SE → attestation → PIN/PIN de coacción → tokenización de tarjeta → precarga de tasas.
  Future<bool> onboard({required String apiUrl, required String apiKey, required String phone, required String pin, required String duressPin, required String pan, required List<TrustedContact> contacts}) async {
    final ok = await _guard('Onboarding', () async {
      _api ??= HttpBackendApi(baseUrl: apiUrl, apiKey: apiKey);
      bus = EventBus();
      _se = await SoftwareSecureElement.create();
      await _se.generateSecret('wal');
      _wal = EncryptedWal(MemoryBlobStore(), _se);
      offline = OfflineAgent(se: _se, wal: _wal, bus: bus);
      final guard = IntegrityGuard(probe: probe, allowDebuggable: kDebugMode);
      online = OnlineAgent(api: _api!, offline: offline!, bus: bus, guard: guard);
      pins = PinVault(se: _se, wal: _wal);
      await pins!.setPins(pin, duressPin);
      await online!.register(buildId: buildId, appHash: appHash);
      _add('Dispositivo verificado (attestation) y licenciado');
      await online!.configureProfile(
          phone: phone, pin: pin, duressPin: duressPin,
          contacts: [for (final c in contacts) {'name': c.name, 'phone': c.phone}],
          limits: const OfflineProfile(dailyLimitUsdMinor: 20000, perTxLimitUsdMinor: 10000));
      await online!.tokenize(pan: pan, expMonth: 12, expYear: DateTime.now().year + 3, count: 10);
      _add('Tarjeta tokenizada: ${offline!.availableTokens} tokens de un solo uso en el Secure Element');
      forensic = ForensicLog(se: _se, wal: _wal, deviceId: offline!.deviceId!);
      shield = ShieldProtocol(offline: offline!, sms: sms, bus: bus, contacts: contacts, outbox: _outbox, forensic: forensic);
      decoy = DecoyWallet(sms: sms, contacts: contacts, bus: bus, locate: null);
      bus.on<DoubleSpendDetected>().listen((e) => _add('⚠ Bloqueo preventivo: ${e.reason}', error: true));
      bus.on<ReconcileFinished>().listen((e) => _add('Conciliado: ${e.settled} liquidadas, ${e.declined} rechazadas (${e.deviceStatus})'));
      await _setupTaxi();
      await refreshBalances();
      stage = Stage.ready;
      return true;
    });
    return ok ?? false;
  }

  Future<void> _setupTaxi() async {
    final se = await SoftwareSecureElement.create();
    await se.generateSecret('wal');
    final tbus = EventBus();
    final off = OfflineAgent(se: se, wal: EncryptedWal(MemoryBlobStore(), se), bus: tbus);
    final on = OnlineAgent(api: _api!, offline: off, bus: tbus, guard: IntegrityGuard(probe: probe, allowDebuggable: true));
    await on.register(buildId: buildId, appHash: appHash);
    final phone = '+519${DateTime.now().millisecondsSinceEpoch % 100000000}'.padRight(12, '0').substring(0, 12);
    await on.configureProfile(phone: phone);
    await on.tokenize(pan: '5555555555554444', expMonth: 12, expYear: DateTime.now().year + 3, count: 3);
    _taxi = _Virtual(off, on);
    _add('Taxista virtual listo para la demo (otro teléfono con la app)');
  }

  Future<void> refreshBalances() async {
    final r = await _api!.request('GET', '/v1/devices/${offline!.deviceId}/wallet');
    balances = Map<String, dynamic>.from(r['balances'] as Map);
    notifyListeners();
  }

  /// Sandbox: acredita saldo de prueba.
  Future<void> topUpSandbox(int amountMinor) async {
    await _guard('Recarga sandbox', () async {
      await _api!.request('POST', '/v1/devices/${offline!.deviceId}/fund', {'currency': 'PEN', 'amountMinor': amountMinor});
      await refreshBalances();
      _add('Saldo de prueba acreditado: S/ ${(amountMinor / 100).toStringAsFixed(2)}');
    });
  }

  Future<bool> _biometric(PaymentSummary s) async {
    _add('Biometría confirmada: ${(s.amountMinor / 100).toStringAsFixed(2)} ${s.currency} (≈ ${(s.payerAmountMinor / 100).toStringAsFixed(2)} ${s.payerCurrency}, tasa ${(s.rateMicros / 1e6).toStringAsFixed(4)}, hash ${s.hash.substring(0, 10)}…)');
    return true;
  }

  /// Pago BLE/NFC contra el taxista virtual (loopback) — sin internet entre los teléfonos.
  Future<void> payNearby({required int amountMinor, required String currency, required bool nfc}) async {
    if (shield?.decoy == true) return payDecoy(amountMinor, currency);
    await _guard(nfc ? 'Pago NFC' : 'Pago Bluetooth', () async {
      final taxi = _taxi!;
      final (a, b) = LoopbackTransport.pair();
      final res = await Future.wait([
        SecureSession.runPayer(offline!, a, _biometric),
        SecureSession.runPayee(taxi.offline, b, amountMinor: amountMinor, currency: currency, confirm: (s) async => true, channel: nfc ? 'nfc' : 'ble'),
      ]);
      _add('Pago offline firmado (${res[0]['txId']}) — en cola para conciliar al recuperar red');
    });
  }

  Future<void> payQr({required int amountMinor, required String currency}) async {
    if (shield?.decoy == true) return payDecoy(amountMinor, currency);
    await _guard('Pago QR dinámico', () async {
      final q = await _api!.request('POST', '/v1/qr/dynamic', {'deviceId': _taxi!.offline.deviceId, 'amountMinor': amountMinor, 'currency': currency});
      final qr = await DynamicQr.parseAndVerify(q['qr'] as String, offline!.serverPublicKey!, now: offline!.now());
      _add('QR verificado offline con la clave del servidor (${qr.amountMinor / 100} ${qr.currency})');
      final art = await QrPaymentFlow(offline!).payScanned(qr);
      final r = await _api!.request('POST', '/v1/authorize-offline', QrPaymentFlow.parseResponseQr(QrPaymentFlow.responseQr(art.voucher)));
      _add('QR respondido; el cobrador lo subió al backend → ${r['status']}');
      await refreshBalances();
    });
  }

  Future<void> payEmv(String emvPayload, {required bool online}) async {
    if (shield?.decoy == true) return payDecoy(1, 'PEN');
    await _guard('Pago QR EMVCo', () async {
      final plan = await EmvPayer(offline!).plan(emvPayload, online: online);
      _add('QR ${plan.qr!.wallet.toUpperCase()} reconocido (${plan.qr!.merchantName}); modo: ${plan.mode}');
      final r = await _api!.request('POST', '/v1/qr/emv/route', {'emvPayload': emvPayload, 'voucher': plan.voucher});
      _add('Pasarela (mock): ${(r['gateway'] as Map?)?['status'] ?? r['tx']}');
      await refreshBalances();
    });
  }

  Future<void> paySms({required String payeePhone, required int amountMinor}) async {
    if (shield?.decoy == true) return payDecoy(amountMinor, 'PEN');
    await _guard('Pago por SMS', () async {
      final phone = normalizePhone(payeePhone);
      final msg = await SmsPayment(offline!, sms).compose(payeePhone: phone, amountMinor: amountMinor, currency: 'PEN');
      await sms.send('+51900000000', msg);
      _add('SWPAY1 cifrado listo (${SmsPayment.partsFor(msg)} SMS)');
    });
  }

  Future<void> payDecoy(int amountMinor, String currency) async {
    final ref = await decoy!.attemptPayment(amountMinor, currency);
    _add('Pago realizado ($ref)'); // el atacante ve «éxito»; los contactos reciben la alerta silenciosa
  }

  /// Recupera red: comandos remotos → tasas → replay del WAL → pánico en cola.
  Future<void> syncNow() async {
    await _guard('Sincronización', () async {
      if (shield != null && (await _outbox.readLines()).isNotEmpty) {
        final n = await shield!.flushOutbox((r) async => await _api!.request('POST', '/v1/panic', r));
        _add('Pánico firmado entregado al backend ($n)');
      }
      if (offline!.se.isWiped) {
        _add('El Escudo está activo: no hay claves para sincronizar');
        return;
      }
      final s = await online!.onNetworkRecovered();
      if (s != null) _add('Replay del WAL: ${s.accepted} entradas aceptadas');
      await refreshBalances();
    });
  }

  /// Botón de pánico (< 3 s, sin red).
  Future<void> panic({bool duress = false}) async {
    await _guard('Protocolo Escudo', () async {
      final r = await shield!.activate(duress ? ShieldTrigger.duressPin : ShieldTrigger.button);
      stage = Stage.shielded;
      _add('ESCUDO ACTIVADO en ${r.elapsedMs} ms — ${r.steps.join(' → ')}');
    });
  }

  /// Desbloqueo con PIN: el PIN de coacción abre una billetera señuelo con saldos falsos.
  Future<PinResult> unlockWithPin(String pin) async {
    final r = await pins!.verify(pin);
    if (r == PinResult.duress && stage == Stage.ready) {
      await shield!.activate(ShieldTrigger.duressPin, pin: pin);
      stage = Stage.ready; // la pantalla sigue «normal», con saldos señuelo
      balances = Map<String, dynamic>.from(decoy!.balances);
      notifyListeners();
    }
    return r;
  }

  String get summaryJson => jsonEncode({'device': offline?.deviceId, 'tokens': offline?.availableTokens, 'pending': offline?.pendingEntries().length, 'frozen': offline?.frozen});
}

class _Virtual {
  _Virtual(this.offline, this.online);
  final OfflineAgent offline;
  final OnlineAgent online;
}
