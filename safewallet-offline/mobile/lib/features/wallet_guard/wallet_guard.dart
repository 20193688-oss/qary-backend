import '../../core/dual_agent/offline_agent.dart';
import '../../core/integrity/integrity_guard.dart';
import '../../core/models.dart';
import '../../core/panic/shield.dart';

class PayRequest {
  const PayRequest({required this.wallet, required this.amountMinor, required this.currency, this.merchantRef, this.payeeDeviceId, this.payeeRef, this.country, this.stepUp, this.channel = 'nfc', this.nonce});
  final String wallet; // 'safewallet' | 'google_pay' | 'apple_pay'
  final int amountMinor;
  final String currency;
  final String? merchantRef, payeeDeviceId, payeeRef, country, nonce;
  final StepUp? stepUp;
  final String channel;
}

class GuardDecision {
  const GuardDecision({required this.allowed, required this.reason, this.voucher, this.decoyRef, this.silentAlert = false});
  final bool allowed;
  final String reason;
  final Map<String, dynamic>? voucher;
  final String? decoyRef;
  final bool silentAlert;
}

/// «Wallet Guard»: intercepta cada pago (SafeWallet, Google Pay, Apple Pay) y lo valida contra el Protocolo Escudo,
/// la integridad del entorno y los límites antes de liberar cualquier token/criptograma.
class WalletGuard {
  WalletGuard({required this.offline, required this.integrity, required this.shield, this.decoy, this.behavior});
  final OfflineAgent offline;
  final IntegrityGuard integrity;
  final ShieldProtocol shield;
  final DecoyWallet? decoy;
  final BehaviorMonitor? behavior;

  Future<GuardDecision> intercept(PayRequest r) async {
    if (shield.decoy && decoy != null) {
      final ref = await decoy!.attemptPayment(r.amountMinor, r.currency);
      return GuardDecision(allowed: true, reason: 'decoy', decoyRef: ref, silentAlert: true); // «éxito» falso + alerta silenciosa
    }
    if (shield.active || offline.frozen) return const GuardDecision(allowed: false, reason: 'shield_active');
    final rep = await integrity.evaluate();
    if (!rep.trusted) return GuardDecision(allowed: false, reason: 'untrusted_environment:${rep.reasons.join('+')}');
    if (behavior != null && behavior!.isAnomalous && !(r.stepUp?.biometric == true && r.stepUp?.pin == true)) {
      return const GuardDecision(allowed: false, reason: 'behavior_anomaly_step_up_required');
    }
    try {
      final art = await offline.createPayment(PaymentRequest(
          payeeDeviceId: r.payeeDeviceId, payeeRef: r.payeeRef, amountMinor: r.amountMinor, currency: r.currency, channel: r.channel,
          merchantRef: r.merchantRef, country: r.country, stepUp: r.stepUp, nonce: r.nonce, extra: {'wallet': r.wallet}));
      return GuardDecision(allowed: true, reason: 'ok', voucher: art.voucher);
    } on StepUpRequired catch (e) {
      return GuardDecision(allowed: false, reason: 'step_up_required:${e.score}');
    } on OfflineLimitExceeded catch (e) {
      return GuardDecision(allowed: false, reason: 'offline_limit:${e.message}');
    } on NoTokensAvailable {
      return const GuardDecision(allowed: false, reason: 'no_tokens');
    } on DeviceFrozen {
      return const GuardDecision(allowed: false, reason: 'shield_active');
    }
  }
}

/// Simulación del flujo de pago nativo de Google Pay / Apple Pay con tokens precargados (TTL extendido).
/// El «tap» pasa SIEMPRE por [WalletGuard]; si el Escudo está activo, el token deja de existir.
class WalletSimulator {
  WalletSimulator(this.guard);
  final WalletGuard guard;

  Future<GuardDecision> tapToPay(String wallet, {required int amountMinor, required String currency, String? merchantRef, String? payeeDeviceId, String? country, StepUp? stepUp}) {
    if (wallet != 'google_pay' && wallet != 'apple_pay') throw ArgumentError('wallet no soportada: $wallet');
    return guard.intercept(PayRequest(wallet: wallet, amountMinor: amountMinor, currency: currency, merchantRef: merchantRef, payeeDeviceId: payeeDeviceId, payeeRef: payeeDeviceId == null ? 'pos:${merchantRef ?? 'unknown'}' : null, country: country, stepUp: stepUp));
  }
}
