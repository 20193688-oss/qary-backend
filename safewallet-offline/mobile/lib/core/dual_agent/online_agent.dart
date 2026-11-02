import 'dart:convert';

import '../../features/multi_currency/fx.dart';
import '../crypto/canonical.dart';
import '../crypto/crypto.dart';
import '../integrity/integrity_guard.dart';
import '../models.dart';
import 'backend_api.dart';
import 'bus.dart';
import 'offline_agent.dart';

abstract class ConnectivityProbe {
  Future<bool> isOnline();
}

/// Centinela-Net: agente con red (WiFi, datos, o saldo de línea). Se sincroniza con el backend:
/// attestation, tokens, tasas, replay del WAL, conciliación y comandos remotos.
class OnlineAgent {
  OnlineAgent({required this.api, required this.offline, required this.bus, required this.guard, Clock clock = systemClock}) : _clock = clock;
  final BackendApi api;
  final OfflineAgent offline;
  final EventBus bus;
  final IntegrityGuard guard;
  final Clock _clock;

  /// Onboarding: attestation + licencia por dispositivo + claves + tasas.
  Future<Map<String, dynamic>> register({required String buildId, required String appHash, String platform = 'sandbox'}) async {
    final ch = await api.request('GET', '/v1/attest/challenge');
    final report = await guard.evaluate();
    final statement = <String, dynamic>{
      'nonce': ch['challenge'], 'publicKey': offline.se.publicKey, 'platform': platform, 'buildId': buildId, 'appHash': appHash,
      'rooted': report.rooted, 'emulator': report.emulator, 'hooked': report.hooked, 'debuggable': report.debuggable,
      'integrityToken': await offline.se.platformIntegrityToken(), 'ts': _clock(),
    };
    final sig = await offline.se.sign(SwCrypto.utf8Bytes(canonicalJson(statement)));
    final resp = await api.request('POST', '/v1/attest', {'statement': statement, 'signature': sig});
    if (resp['trusted'] != true) throw SwException('device_untrusted', 'el backend no confía en este dispositivo', resp['reasons']);
    await offline.applyAttestation(resp);
    return resp;
  }

  Future<void> configureProfile({String? phone, String? pin, String? duressPin, String? email, List<Map<String, String>>? contacts, Map<String, dynamic>? safeZone, OfflineProfile? limits}) async {
    final body = <String, dynamic>{
      'phone': ?phone, 'pin': ?pin, 'duressPin': ?duressPin, 'email': ?email, 'trustedContacts': ?contacts, 'safeZone': ?safeZone,
      if (limits != null) ...{'offlineDailyLimitUsdMinor': limits.dailyLimitUsdMinor, 'offlinePerTxLimitUsdMinor': limits.perTxLimitUsdMinor, 'whitelistMerchants': limits.whitelistMerchants},
    };
    await api.request('PUT', '/v1/devices/${offline.deviceId}/profile', body);
    if (limits != null) await offline.setProfile(limits);
  }

  Future<void> tokenize({required String pan, required int expMonth, required int expYear, String currency = 'PEN', int count = 10}) async {
    final r = await api.request('POST', '/v1/tokenize', {'deviceId': offline.deviceId, 'pan': pan, 'expMonth': expMonth, 'expYear': expYear, 'currency': currency, 'count': count});
    await offline.applyTokens(r);
  }

  Future<void> syncRates() async {
    final r = await api.request('GET', '/v1/rates');
    await offline.addRates(RateSnapshot.fromJson(r));
  }

  Future<void> rotateKeys() async {
    final ts = _clock();
    final sig = await offline.se.sign(SwCrypto.utf8Bytes(canonicalJson({'op': 'rotate', 'deviceId': offline.deviceId, 'ts': ts})));
    final r = await api.request('POST', '/v1/devices/${offline.deviceId}/keys/rotate', {'ts': ts, 'signature': sig});
    await offline.applyRotatedKeys(r);
  }

  /// Replay del WAL contra el backend. Si hay doble gasto / ledger manipulado, el backend bloquea y aquí se notifica.
  Future<ReconcileSummary> reconcile() async {
    final pending = offline.pendingEntries();
    if (pending.isEmpty) return const ReconcileSummary(0, true, 'active', 0, 0, []);
    final r = await api.request('POST', '/v1/reconcile', {'deviceId': offline.deviceId, 'entries': pending.map((e) => e.toJson()).toList()});
    final results = (r['results'] as List).cast<Map<String, dynamic>>();
    var settled = 0, declined = 0;
    for (final x in results) {
      final st = x['status'];
      if (st == 'settled') settled++;
      if (st == 'declined' || st == 'rejected') declined++;
    }
    final chainOk = r['chainOk'] as bool;
    final status = r['deviceStatus'] as String;
    if (chainOk) await offline.markReconciled(r['lastSeq'] as int);
    final summary = ReconcileSummary(r['accepted'] as int, chainOk, status, settled, declined, results);
    bus.publish(ReconcileFinished(accepted: summary.accepted, chainOk: chainOk, deviceStatus: status, settled: settled, declined: declined));
    if (!chainOk || status == 'locked' || status == 'blocked') {
      // bloqueo preventivo: congelar el ledger local y avisar al usuario
      await offline.freeze(chainOk ? 'preventive_lock:$status' : 'ledger_rejected:${r['chainError']}');
      bus.publish(DoubleSpendDetected(chainOk ? 'device_$status' : '${r['chainError']}'));
    }
    return summary;
  }

  /// Comandos remotos pendientes (p. ej. SE_WIPE tras Protocolo Escudo remoto). Devuelve los ejecutados.
  Future<List<String>> pollCommands() async {
    final d = await api.request('GET', '/v1/devices/${offline.deviceId}');
    // SE_WIPE siempre al final: el resto de comandos necesita el SE vivo para dejar constancia en el WAL cifrado.
    final cmds = List<String>.from(d['pendingCommands'] as List)..sort((a, b) => (a == 'SE_WIPE' ? 1 : 0) - (b == 'SE_WIPE' ? 1 : 0));
    final done = <String>[];
    for (final c in cmds) {
      switch (c) {
        case 'FREEZE_LEDGER':
          await offline.freeze('remote_shield');
          done.add(c);
        case 'SE_WIPE':
          await offline.revokeAllTokens();
          await offline.se.wipe();
          done.add(c);
        case 'ENTER_DECOY':
        case 'INVALIDATE_SESSIONS':
          done.add(c);
      }
    }
    if (done.isNotEmpty) {
      // El ack no necesita firma del dispositivo (el SE puede haber sido borrado): basta la API key del cliente.
      await api.request('POST', '/v1/devices/${offline.deviceId}/commands/ack', {'commands': done});
    }
    bus.publish(ShieldActivated('remote', silent: cmds.contains('ENTER_DECOY')));
    return done;
  }

  /// Secuencia al recuperar red: comandos remotos → tasas → conciliación.
  Future<ReconcileSummary?> onNetworkRecovered() async {
    bus.publish(const NetworkChanged(true));
    try {
      final cmds = await pollCommands();
      if (offline.se.isWiped) return null;
      if (cmds.isEmpty) {
        await syncRates();
      }
      return await reconcile();
    } on SwException catch (e) {
      bus.publish(AgentError('online', e));
      rethrow;
    }
  }

  Future<void> uploadForensic(List<Map<String, dynamic>> entries) async {
    await api.request('POST', '/v1/forensic/${offline.deviceId}/logs', {'entries': entries});
  }

  String describe() => jsonEncode({'deviceId': offline.deviceId, 'pending': offline.pendingEntries().length});
}

class ReconcileSummary {
  const ReconcileSummary(this.accepted, this.chainOk, this.deviceStatus, this.settled, this.declined, this.results);
  final int accepted;
  final bool chainOk;
  final String deviceStatus;
  final int settled;
  final int declined;
  final List<Map<String, dynamic>> results;
}
