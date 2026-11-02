import 'dart:convert';
import 'dart:io';

import '../../core/crypto/canonical.dart';
import '../../core/crypto/crypto.dart';
import '../../core/dual_agent/offline_agent.dart';
import '../../core/models.dart';
import '../../core/panic/sms_gateway.dart';

/// Pago de emergencia por SMS cifrado (solo línea celular). Formato: `SWPAY1.deviceId.época.base64url(iv|ct|tag)`,
/// donde ct = AES-256-GCM(deflateRaw(JSON canónico)) con la clave SMS custodiada por el Secure Element.
class SmsPayment {
  SmsPayment(this.agent, this.gateway);
  final OfflineAgent agent;
  final SmsGateway gateway;

  /// Número de SMS (153 caracteres por parte en mensajes concatenados) necesarios para el texto.
  static int partsFor(String text) => (text.length / 153).ceil();

  Future<String> compose({required String payeePhone, required int amountMinor, required String currency, String? payerCurrency, String? country, StepUp? stepUp}) async {
    final payload = await agent.prepareSmsPayment(payeePhone: payeePhone, amountMinor: amountMinor, currency: currency, payerCurrency: payerCurrency, country: country, stepUp: stepUp);
    final plain = utf8.encode(canonicalJson(payload));
    final z = ZLibEncoder(raw: true, level: 9).convert(plain);
    final epoch = agent.keyEpoch;
    final s = await agent.sealForSms(z, aad: 'sw-sms|${agent.deviceId}|$epoch');
    final blob = [...SwCrypto.unb64u(s['iv']!), ...SwCrypto.unb64u(s['ct']!), ...SwCrypto.unb64u(s['tag']!)];
    return 'SWPAY1.${agent.deviceId}.$epoch.${SwCrypto.b64u(blob)}';
  }

  /// Compone y envía el SMS al número del gateway de SafeWallet (o directamente al backend de la fintech).
  Future<String> send(String gatewayNumber, {required String payeePhone, required int amountMinor, required String currency, String? payerCurrency, String? country, StepUp? stepUp}) async {
    final msg = await compose(payeePhone: payeePhone, amountMinor: amountMinor, currency: currency, payerCurrency: payerCurrency, country: country, stepUp: stepUp);
    await gateway.send(gatewayNumber, msg);
    return msg;
  }

  /// Descifra con una clave dada (vectores de interoperabilidad / pruebas). El dispositivo real nunca expone su clave.
  static Future<Map<String, dynamic>> decodeWithKey(List<int> key, String message) async {
    final parts = message.split('.');
    if (parts.length != 4 || parts[0] != 'SWPAY1') throw SwException('sms_malformed', 'formato SWPAY1 inválido');
    final blob = SwCrypto.unb64u(parts[3]);
    final plain = await SwCrypto.aesDecrypt(key, {'iv': SwCrypto.b64u(blob.sublist(0, 12)), 'ct': SwCrypto.b64u(blob.sublist(12, blob.length - 16)), 'tag': SwCrypto.b64u(blob.sublist(blob.length - 16))}, aad: 'sw-sms|${parts[1]}|${parts[2]}');
    return jsonDecode(utf8.decode(ZLibDecoder(raw: true).convert(plain))) as Map<String, dynamic>;
  }
}

/// Selección de contacto de la agenda → teléfono E.164 para el pago por SMS.
String normalizePhone(String raw, {String defaultCountryCode = '51'}) {
  var d = raw.replaceAll(RegExp(r'[^\d+]'), '');
  if (d.startsWith('+')) {
    d = d.substring(1);
  } else if (d.startsWith('00')) {
    d = d.substring(2);
  } else if (d.length == 9) {
    d = '$defaultCountryCode$d';
  }
  if (!RegExp(r'^\d{8,15}$').hasMatch(d)) throw SwException('bad_phone', 'teléfono inválido: $raw');
  return '+$d';
}
