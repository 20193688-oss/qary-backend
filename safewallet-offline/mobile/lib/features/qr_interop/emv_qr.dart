import '../../core/crypto/crypto.dart';
import '../../core/dual_agent/offline_agent.dart';
import '../../core/models.dart';

/// Adaptador de interoperabilidad EMVCo MPM (el estándar de Yape, Plin y la mayoría de billeteras).
class EmvQr {
  EmvQr({required this.valid, required this.dynamic, required this.wallet, required this.merchantName, required this.city, required this.country, required this.mcc, required this.currency, required this.amountMinor, required this.accountId, required this.guid, required this.emvHash});
  final bool valid;
  final bool dynamic;
  final String wallet;
  final String merchantName, city, country, mcc, accountId, guid, emvHash;
  final String? currency;
  final int? amountMinor;

  static const numericCurrency = {'604': 'PEN', '840': 'USD', '978': 'EUR', '188': 'CRC', '928': 'VES', '170': 'COP'};

  static String crc16(String s) {
    var crc = 0xffff;
    for (final b in SwCrypto.utf8Bytes(s)) {
      crc ^= b << 8;
      for (var k = 0; k < 8; k++) {
        crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc.toRadixString(16).toUpperCase().padLeft(4, '0');
  }

  static String _tlv(String tag, String value) => tag + value.length.toString().padLeft(2, '0') + value;

  /// Construye un QR EMVCo MPM válido (con CRC16). Usado por la demo y para pruebas de interoperabilidad.
  static String build({required bool dynamic, required String guid, required String account, String mcc = '0000', required String currencyNumeric, String? amount, required String country, required String name, required String city, String? reference}) {
    var s = _tlv('00', '01') + _tlv('01', dynamic ? '12' : '11') + _tlv('26', _tlv('00', guid) + _tlv('01', account));
    s += _tlv('52', mcc) + _tlv('53', currencyNumeric);
    if (amount != null) s += _tlv('54', amount);
    s += _tlv('58', country) + _tlv('59', name) + _tlv('60', city);
    if (reference != null) s += _tlv('62', _tlv('05', reference));
    s += '6304';
    return s + crc16(s);
  }

  static List<({String tag, String value})> parseTlv(String s) {
    final out = <({String tag, String value})>[];
    var i = 0;
    while (i < s.length) {
      if (i + 4 > s.length) throw SwException('emv_malformed', 'TLV truncado');
      final tag = s.substring(i, i + 2), lenS = s.substring(i + 2, i + 4);
      final len = int.tryParse(lenS);
      if (int.tryParse(tag) == null || len == null) throw SwException('emv_malformed', 'tag o longitud no numérica');
      if (i + 4 + len > s.length) throw SwException('emv_malformed', 'longitud excede el payload en tag $tag');
      out.add((tag: tag, value: s.substring(i + 4, i + 4 + len)));
      i += 4 + len;
    }
    return out;
  }

  static String _walletOf(String guid, String name) {
    final s = '$guid $name'.toLowerCase();
    if (s.contains('yape')) return 'yape';
    if (s.contains('plin')) return 'plin';
    if (s.contains('interbank') || s.contains('ibk')) return 'interbank';
    if (s.contains('bcp')) return 'bcp';
    return 'unknown';
  }

  static Future<EmvQr> parse(String payload) async {
    final p = payload.trim();
    final top = parseTlv(p);
    String? get(String t) {
      for (final x in top) {
        if (x.tag == t) return x.value;
      }
      return null;
    }

    if (get('00') != '01') throw SwException('emv_not_payment', 'no es un QR EMVCo de pago');
    final m = RegExp(r'6304([0-9A-Fa-f]{4})$').firstMatch(p);
    if (m == null) throw SwException('emv_no_crc', 'falta CRC (tag 63)');
    if (crc16(p.substring(0, p.length - 4)) != m.group(1)!.toUpperCase()) throw SwException('emv_crc_invalid', 'CRC16 inválido: QR corrupto o manipulado');
    ({String tag, String value})? acct;
    for (final x in top) {
      final n = int.parse(x.tag);
      if (n >= 26 && n <= 51) {
        acct = x;
        break;
      }
    }
    if (acct == null) throw SwException('emv_no_account', 'sin información de cuenta del comercio');
    final sub = parseTlv(acct.value);
    String subGet(String t) => sub.where((x) => x.tag == t).map((x) => x.value).firstOrNull ?? '';
    final amt = get('54');
    int? amountMinor;
    if (amt != null) {
      if (!RegExp(r'^\d+(\.\d{1,2})?$').hasMatch(amt)) throw SwException('emv_bad_amount', 'monto inválido');
      final parts = amt.split('.');
      amountMinor = int.parse(parts[0]) * 100 + int.parse((parts.length > 1 ? parts[1] : '').padRight(2, '0'));
    }
    final name = get('59') ?? '';
    final guid = subGet('00');
    return EmvQr(
        valid: true, dynamic: get('01') == '12', wallet: _walletOf(guid, name), merchantName: name, city: get('60') ?? '', country: get('58') ?? '', mcc: get('52') ?? '',
        currency: numericCurrency[get('53') ?? ''], amountMinor: amountMinor, accountId: subGet('01'), guid: guid, emvHash: await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(p)));
  }
}

/// Resultado de decidir cómo pagar un QR EMVCo.
class EmvPaymentPlan {
  const EmvPaymentPlan({required this.mode, this.voucher, this.qr});
  final String mode; // 'online_gateway' | 'deferred_voucher'
  final Map<String, dynamic>? voucher;
  final EmvQr? qr;
}

class EmvPayer {
  EmvPayer(this.agent);
  final OfflineAgent agent;

  /// Con red → el backend enruta a la pasarela (`POST /v1/qr/emv/route`). Sin red → voucher firmado diferido para entregar
  /// por Bluetooth/QR a quien sí tenga red (p. ej. el taxista), que lo sube al backend.
  Future<EmvPaymentPlan> plan(String emvPayload, {required bool online, int? amountMinor, StepUp? stepUp, String? country}) async {
    final qr = await EmvQr.parse(emvPayload);
    if (qr.currency == null) throw SwException('emv_currency', 'moneda del QR no soportada');
    final amount = qr.amountMinor ?? amountMinor;
    if (amount == null) throw SwException('emv_amount_required', 'el QR es estático: ingresa el monto');
    if (qr.amountMinor != null && amountMinor != null && qr.amountMinor != amountMinor) throw SwException('emv_amount_mismatch', 'el monto no coincide con el QR');
    final art = await agent.createPayment(PaymentRequest(
        payeeRef: 'emv:${qr.wallet}:${qr.accountId}', amountMinor: amount, currency: qr.currency!, channel: 'qr_emv', stepUp: stepUp, country: country,
        extra: {'emvHash': qr.emvHash}));
    return EmvPaymentPlan(mode: online ? 'online_gateway' : 'deferred_voucher', voucher: art.voucher, qr: qr);
  }
}
