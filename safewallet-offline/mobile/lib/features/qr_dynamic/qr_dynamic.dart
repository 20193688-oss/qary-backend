import 'dart:convert';

import '../../core/crypto/canonical.dart';
import '../../core/crypto/crypto.dart';
import '../../core/dual_agent/offline_agent.dart';
import '../../core/models.dart';
import '../multi_currency/fx.dart';

/// QR dinámico firmado por el backend (`SWQR1:`). Se verifica 100 % offline con la clave pública del servidor.
class DynamicQr {
  DynamicQr(this.payload, this.sig);
  final Map<String, dynamic> payload;
  final String sig;

  String get qrId => payload['qrId'] as String;
  String get payeeDeviceId => payload['payeeDeviceId'] as String;
  int get amountMinor => payload['amountMinor'] as int;
  String get currency => payload['currency'] as String;
  int get exp => payload['exp'] as int;
  RateSnapshot? get rates => payload['rates'] == null ? null : RateSnapshot.fromJson(Map<String, dynamic>.from(payload['rates'] as Map));

  static const prefix = 'SWQR1:';
  static const responsePrefix = 'SWQR1R:';

  static Future<DynamicQr> parseAndVerify(String qr, String serverPublicKey, {required int now}) async {
    if (!qr.startsWith(prefix)) throw SwException('qr_bad_prefix', 'no es un QR de SafeWallet');
    Map<String, dynamic> obj;
    try {
      obj = jsonDecode(utf8.decode(SwCrypto.unb64u(qr.substring(prefix.length)))) as Map<String, dynamic>;
    } catch (e) {
      throw SwException('qr_malformed', 'QR ilegible', e);
    }
    final p = Map<String, dynamic>.from(obj['p'] as Map);
    final signed = Map<String, dynamic>.from(p)..remove('rates');
    if (!await SwCrypto.verify(serverPublicKey, SwCrypto.utf8Bytes(canonicalJson(signed)), obj['s'] as String)) throw SwException('qr_bad_signature', 'firma del QR inválida: posible QR falso');
    final q = DynamicQr(p, obj['s'] as String);
    final r = q.rates;
    if (r != null && (r.id != p['rateSnapshotId'] || !await r.verify(serverPublicKey))) throw SwException('qr_bad_rates', 'tasas del QR no firmadas por el servidor');
    if (q.exp < now) throw SwException('qr_expired', 'el QR venció');
    return q;
  }
}

/// El cliente escanea el QR del cobrador, paga en su moneda con la tasa pactada en el QR y devuelve un QR de respuesta
/// (`SWQR1R:`) con el voucher firmado — o lo envía por Bluetooth. El cobrador lo sube al backend cuando tenga red.
class QrPaymentFlow {
  QrPaymentFlow(this.agent);
  final OfflineAgent agent;

  Future<PaymentArtifacts> payScanned(DynamicQr qr, {StepUp? stepUp, String? country}) async {
    final snap = qr.rates;
    if (snap != null && agent.rates!.byId(snap.id) == null) await agent.addRates(snap); // snapshot firmado viene en el QR
    return agent.createPayment(PaymentRequest(
        payeeDeviceId: qr.payeeDeviceId, amountMinor: qr.amountMinor, currency: qr.currency, channel: 'qr', nonce: qr.qrId,
        snapshotId: qr.payload['rateSnapshotId'] as String, stepUp: stepUp, country: country));
  }

  static String responseQr(Map<String, dynamic> voucher) => DynamicQr.responsePrefix + SwCrypto.b64u(utf8.encode(jsonEncode(voucher)));

  static Map<String, dynamic> parseResponseQr(String s) {
    if (!s.startsWith(DynamicQr.responsePrefix)) throw SwException('qr_bad_prefix', 'no es un QR de respuesta de pago');
    return jsonDecode(utf8.decode(SwCrypto.unb64u(s.substring(DynamicQr.responsePrefix.length)))) as Map<String, dynamic>;
  }
}
