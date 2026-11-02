import 'dart:convert';
import 'dart:math';

import '../crypto/canonical.dart';
import '../crypto/crypto.dart';
import '../dual_agent/bus.dart';
import '../dual_agent/offline_agent.dart';
import '../dual_agent/wal.dart';
import '../models.dart';
import 'forensic_log.dart';
import 'pin_vault.dart';
import 'sms_gateway.dart';

enum ShieldTrigger { button, duressPin, sms, remoteWeb, deadman, geofence }

class TrustedContact {
  const TrustedContact(this.name, this.phone);
  final String name;
  final String phone;
}

class GeoPoint {
  const GeoPoint(this.lat, this.lon);
  final double lat;
  final double lon;
}

class ShieldReport {
  const ShieldReport({required this.trigger, required this.silent, required this.elapsedMs, required this.notified, required this.queuedForBackend, required this.steps});
  final ShieldTrigger trigger;
  final bool silent;
  final int elapsedMs;
  final int notified;
  final bool queuedForBackend;
  final List<String> steps;
}

/// Protocolo Escudo (lado dispositivo). Diseñado para completarse en < 3 s SIN red:
/// firma el pánico → lo encola → congela el ledger → revoca tokens → avisa a contactos por SMS → borra el SE.
class ShieldProtocol {
  ShieldProtocol({
    required this.offline, required this.sms, required this.bus, required this.contacts, required this.outbox,
    this.forensic, this.locate, Clock clock = systemClock,
  }) : _clock = clock;
  final OfflineAgent offline;
  final SmsGateway sms;
  final EventBus bus;
  final List<TrustedContact> contacts;
  final BlobStore outbox; // cola de pánico firmada: sobrevive al borrado del SE
  final ForensicLog? forensic;
  final Future<GeoPoint?> Function()? locate;
  final Clock _clock;

  bool active = false;
  bool decoy = false;

  static const _backendTrigger = {ShieldTrigger.button: 'button', ShieldTrigger.duressPin: 'duress_pin'};

  Future<ShieldReport> activate(ShieldTrigger trigger, {String? pin, GeoPoint? where}) async {
    final sw = Stopwatch()..start();
    final steps = <String>[];
    final silent = trigger == ShieldTrigger.duressPin;
    final loc = where ?? await _safeLocate();
    final se = offline.se;

    // 1) pánico firmado y encolado (si el SE sigue vivo y el disparador lo soporta)
    var queued = false;
    String textSig = '';
    const text = 'Fui víctima de robo, no soy yo quien pide dinero. No transfieras ni respondas a mensajes o llamadas desde mis cuentas.';
    if (!se.isWiped) {
      final ts = _clock();
      textSig = (await se.sign(SwCrypto.utf8Bytes(text))).substring(0, 12);
      final bt = _backendTrigger[trigger];
      if (bt != null) {
        final sig = await se.sign(SwCrypto.utf8Bytes(canonicalJson({'op': 'panic', 'deviceId': offline.deviceId, 'ts': ts, 'trigger': bt})));
        await outbox.appendLine(jsonEncode({
          'deviceId': offline.deviceId, 'trigger': bt, 'ts': ts, 'signature': sig, 'pin': ?pin,
          if (loc != null) 'location': {'lat': loc.lat, 'lon': loc.lon},
        }));
        queued = true;
        steps.add('panic_signed_and_queued');
      }
      await forensic?.append('shield', jsonEncode({'trigger': trigger.name, 'silent': silent, 'ts': ts, 'lat': loc?.lat, 'lon': loc?.lon}));
    }

    // 2) congelar ledger y revocar tokens (DPAN) locales
    await offline.freeze('shield:${trigger.name}');
    steps.add('ledger_frozen');
    await offline.revokeAllTokens();
    steps.add('tokens_revoked');

    // 3) SMS firmado a contactos de confianza (usa el crédito del chip, sin datos)
    var notified = 0;
    final where2 = loc == null ? '' : ' Ubicación: https://maps.google.com/?q=${loc.lat},${loc.lon}';
    for (final c in contacts) {
      try {
        await sms.send(c.phone, '[SafeWallet Escudo] $text$where2${textSig.isEmpty ? '' : ' ref:$textSig'}');
        notified++;
      } catch (e) {
        bus.publish(AgentError('shield.sms', e)); // un fallo de SMS no detiene el Escudo
      }
    }
    steps.add('contacts_notified:$notified');

    // 4) borrar claves del Secure Element (irreversible)
    await se.wipe();
    steps.add('se_wiped');

    active = true;
    decoy = silent || decoy;
    bus.publish(ShieldActivated(trigger.name, silent: silent));
    sw.stop();
    return ShieldReport(trigger: trigger, silent: silent, elapsedMs: sw.elapsedMilliseconds, notified: notified, queuedForBackend: queued, steps: steps);
  }

  Future<GeoPoint?> _safeLocate() async {
    try {
      return await locate?.call().timeout(const Duration(milliseconds: 800));
    } catch (_) {
      return null; // sin GPS (o desactivado por el atacante): se continúa sin ubicación
    }
  }

  /// Entrega al backend los pánicos firmados que quedaron en cola. Devuelve cuántos se enviaron.
  Future<int> flushOutbox(Future<void> Function(Map<String, dynamic> request) send) async {
    final lines = await outbox.readLines();
    var sent = 0;
    final remaining = <String>[];
    for (final l in lines) {
      try {
        await send(jsonDecode(l) as Map<String, dynamic>);
        sent++;
      } catch (e) {
        remaining.add(l);
        bus.publish(AgentError('shield.flush', e));
      }
    }
    await outbox.replaceAll(remaining);
    return sent;
  }
}

/// Billetera señuelo: muestra saldos falsos; cualquier intento de pago dispara alerta silenciosa a los contactos.
class DecoyWallet {
  DecoyWallet({required this.sms, required this.contacts, required this.bus, required this.locate, Clock clock = systemClock, Map<String, int>? balances})
      : balances = balances ?? {'PEN': 184250, 'USD': 32010}, _clock = clock;
  final SmsGateway sms;
  final List<TrustedContact> contacts;
  final EventBus bus;
  final Future<GeoPoint?> Function()? locate;
  final Map<String, int> balances;
  final Clock _clock;
  int _lastAlert = 0;
  int alerts = 0;

  /// Simula un pago exitoso (sin mover dinero real) y avisa en silencio.
  Future<String> attemptPayment(int amountMinor, String currency) async {
    bus.publish(const SilentAlert('decoy_payment_attempt'));
    final now = _clock();
    if (now - _lastAlert > 5 * 60 * 1000) {
      _lastAlert = now;
      alerts++;
      GeoPoint? p;
      try {
        p = await locate?.call();
      } catch (_) {
        p = null;
      }
      final where = p == null ? '' : ' https://maps.google.com/?q=${p.lat},${p.lon}';
      for (final c in contacts) {
        await sms.send(c.phone, '[SafeWallet Escudo] Alerta silenciosa: intento de pago bajo coacción.$where');
      }
    }
    return 'ok-${Random().nextInt(1 << 20)}'; // al atacante le parece que funcionó
  }
}

/// Receptor del kill-switch SMS «SAFE-SOS-PIN»: en Android lo alimenta un BroadcastReceiver nativo (ver docs).
class SosSmsHandler {
  SosSmsHandler({required this.pins, required this.shield});
  final PinVault pins;
  final ShieldProtocol shield;
  static final _re = RegExp(r'^\s*SAFE-SOS-(\d{4,8})\s*$', caseSensitive: false);

  /// Devuelve el reporte si activó el Escudo; null si el SMS no es un código de pánico válido.
  Future<ShieldReport?> handleIncoming(String from, String body) async {
    final m = _re.firstMatch(body);
    if (m == null) return null;
    final r = await pins.verify(m.group(1)!);
    if (r == PinResult.real || r == PinResult.duress) {
      return shield.activate(ShieldTrigger.sms);
    }
    return null; // PIN incorrecto o bloqueado: no revela nada al remitente
  }
}

/// Testamento digital: si no hay prueba de vida en [hours], dispara el Escudo.
class DeadManSwitch {
  DeadManSwitch({required this.hours, required this.shield, Clock clock = systemClock}) : _clock = clock, _last = clock();
  final int hours;
  final ShieldProtocol shield;
  final Clock _clock;
  int _last;

  void checkIn() => _last = _clock();

  Future<ShieldReport?> evaluate() async {
    if (shield.active || _clock() - _last <= hours * 3600 * 1000) return null;
    return shield.activate(ShieldTrigger.deadman);
  }
}

/// Geofencing de riesgo: salir de la zona segura sin biometría reciente congela el ledger (bloqueo preventivo).
class Geofence {
  Geofence({required this.center, required this.radiusM, required this.offline});
  final GeoPoint center;
  final double radiusM;
  final OfflineAgent offline;

  static double haversineM(GeoPoint a, GeoPoint b) {
    const r = 6371000.0;
    double rad(double x) => x * pi / 180;
    final h = pow(sin(rad(b.lat - a.lat) / 2), 2) + cos(rad(a.lat)) * cos(rad(b.lat)) * pow(sin(rad(b.lon - a.lon) / 2), 2);
    return 2 * r * asin(sqrt(h));
  }

  Future<bool> evaluate(GeoPoint here, {required bool biometricRecent}) async {
    final inside = haversineM(center, here) <= radiusM;
    if (!inside && !biometricRecent && !offline.frozen) {
      await offline.freeze('geofence_breach');
      return false;
    }
    return inside;
  }
}

/// Biometría continua (comportamiento): cadencia de tecleo frente a la línea base del propietario.
class BehaviorMonitor {
  BehaviorMonitor({this.zThreshold = 3.0, this.minBaseline = 20});
  final double zThreshold;
  final int minBaseline;
  final List<double> _baseline = [];
  final List<double> _recent = [];
  int? _lastTs;

  void recordKeyDown(int tsMs, {bool calibrating = false}) {
    final last = _lastTs;
    _lastTs = tsMs;
    if (last == null) return;
    final dt = (tsMs - last).toDouble();
    if (dt > 5000) return; // pausa larga: no es cadencia
    (calibrating ? _baseline : _recent).add(dt);
    if (_recent.length > 50) _recent.removeAt(0);
  }

  void resetSession() => _lastTs = null;

  static double _mean(List<double> v) => v.reduce((a, b) => a + b) / v.length;
  static double _std(List<double> v, double m) => sqrt(v.map((x) => pow(x - m, 2)).reduce((a, b) => a + b) / v.length);

  /// z-score de la media reciente respecto a la línea base (≥ [zThreshold] ⇒ posible usuario distinto).
  double anomalyScore() {
    if (_baseline.length < minBaseline || _recent.length < 10) return 0;
    final m = _mean(_baseline);
    final s = max(_std(_baseline, m), 1.0);
    final rm = _mean(_recent);
    return (rm - m).abs() / (s / sqrt(_recent.length));
  }

  bool get isAnomalous => anomalyScore() >= zThreshold;
}
