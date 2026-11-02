import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../../core/crypto/canonical.dart';
import '../../core/crypto/crypto.dart';
import '../../core/crypto/ratchet.dart';
import '../../core/dual_agent/offline_agent.dart';
import '../../core/models.dart';
import 'transport.dart';

/// Detalle que ambos usuarios ven y confirman con biometría antes de firmar.
class PaymentSummary {
  const PaymentSummary({required this.amountMinor, required this.currency, required this.payerAmountMinor, required this.payerCurrency, required this.rateMicros, required this.marginBps, required this.hash});
  final int amountMinor;
  final String currency;
  final int payerAmountMinor;
  final String payerCurrency;
  final int rateMicros;
  final int marginBps;
  final String hash; // hash de la transacción que se firma
}

typedef BiometricConfirm = Future<bool> Function(PaymentSummary summary);

/// Sesión de pago offline entre dos teléfonos (BLE o NFC): handshake autenticado con certificados del servidor,
/// canal cifrado con double ratchet, confirmación biométrica en ambos lados y recibo contrafirmado.
class SecureSession {
  SecureSession._(this.agent, this.transport, this.role);
  final OfflineAgent agent;
  final PeerTransport transport;
  final String role; // 'payer' | 'payee'
  late RatchetSession _ratchet;
  DeviceCertificate? peer;
  late final StreamIterator<Uint8List> _it = StreamIterator(transport.incoming);
  final BleFrameCodec _codec = BleFrameCodec();
  bool _started = false;

  Future<Map<String, dynamic>> _recv({Duration timeout = const Duration(seconds: 10)}) async {
    if (!_started) _started = true;
    Uint8List? whole;
    while (whole == null) {
      if (!await _it.moveNext().timeout(timeout, onTimeout: () => throw SwException('session_timeout', 'el otro teléfono no respondió'))) {
        throw SwException('session_closed', 'canal cerrado');
      }
      whole = _codec.feed(_it.current);
    }
    return jsonDecode(utf8.decode(whole)) as Map<String, dynamic>;
  }

  Future<void> _send(Map<String, dynamic> m) async {
    for (final f in _codec.split(SwCrypto.utf8Bytes(jsonEncode(m)))) {
      await transport.send(f);
    }
  }

  Future<void> _sendEnc(String type, Map<String, dynamic> body) async {
    final enc = await _ratchet.encrypt(SwCrypto.utf8Bytes(jsonEncode({'t': type, 'b': body})), aad: 'sw-pay');
    await _send({'enc': enc});
  }

  Future<(String, Map<String, dynamic>)> _recvEnc() async {
    final m = await _recv();
    final plain = await _ratchet.decrypt(Map<String, dynamic>.from(m['enc'] as Map), aad: 'sw-pay');
    final j = jsonDecode(utf8.decode(plain)) as Map<String, dynamic>;
    return (j['t'] as String, Map<String, dynamic>.from(j['b'] as Map));
  }

  Future<Map<String, dynamic>> _hello(SwKeyPair eph, String nonce) async {
    final cert = agent.certificate!;
    final body = {'cert': cert.toJson(), 'eph': eph.publicRaw, 'nonce': nonce, 'role': role};
    final sig = await agent.se.sign(SwCrypto.utf8Bytes(canonicalJson(body)));
    return {...body, 'sig': sig};
  }

  Future<DeviceCertificate> _verifyHello(Map<String, dynamic> h, String expectedRole) async {
    final cert = DeviceCertificate.fromJson(Map<String, dynamic>.from(h['cert'] as Map));
    if (!await SwCrypto.verify(agent.serverPublicKey!, SwCrypto.utf8Bytes(canonicalJson(cert.body)), cert.sig)) throw SwException('peer_cert_invalid', 'el otro teléfono no tiene certificado válido del servidor');
    if (cert.expiresAt < agent.now()) throw SwException('peer_cert_expired', 'licencia vencida');
    if (h['role'] != expectedRole) throw SwException('peer_role', 'rol inesperado del otro teléfono');
    final body = {'cert': h['cert'], 'eph': h['eph'], 'nonce': h['nonce'], 'role': h['role']};
    if (!await SwCrypto.verify(cert.publicKey, SwCrypto.utf8Bytes(canonicalJson(body)), h['sig'] as String)) throw SwException('peer_hello_invalid', 'handshake no autenticado');
    return cert;
  }

  Future<Uint8List> _secret(SwKeyPair eph, String peerEph, String n1, String n2) async {
    final dh = await SwCrypto.ecdh(eph, peerEph);
    return SwCrypto.hkdf(dh, SwCrypto.utf8Bytes('$n1|$n2'), 'sw-session-sk');
  }

  // ------------------------------------------------------------------ PAGADOR
  /// Ejecuta el flujo completo del pagador. [confirm] muestra monto/moneda/tasa/hash y pide biometría.
  static Future<Map<String, dynamic>> runPayer(OfflineAgent agent, PeerTransport t, BiometricConfirm confirm, {StepUp? stepUp, String? country, String? merchantRef}) async {
    final s = SecureSession._(agent, t, 'payer');
    try {
      final eph = await SwCrypto.generateKeyPair();
      final myNonce = SwCrypto.randomHex(12);
      await s._send({'hello': await s._hello(eph, myNonce)});
      final peerHello = Map<String, dynamic>.from((await s._recv())['hello'] as Map);
      s.peer = await s._verifyHello(peerHello, 'payee');
      final sk = await s._secret(eph, peerHello['eph'] as String, myNonce, peerHello['nonce'] as String);
      s._ratchet = await RatchetSession.initiator(sk, peerHello['eph'] as String);
      // iniciador debe hablar primero para crear la cadena del respondedor
      await s._sendEnc('ready', {'deviceId': agent.deviceId});
      final (type, req) = await s._recvEnc();
      if (type != 'pay_request') throw SwException('protocol', 'se esperaba pay_request, llegó $type');
      final pr = PaymentRequest(
          payeeDeviceId: s.peer!.deviceId, amountMinor: req['amountMinor'] as int, currency: req['currency'] as String,
          channel: (req['channel'] as String?) ?? 'ble', merchantRef: merchantRef ?? req['merchantRef'] as String?, country: country, stepUp: stepUp, nonce: req['requestId'] as String);
      final prev = await agent.preview(pr);
      final summaryHash = await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(canonicalJson({...prev, 'payee': s.peer!.deviceId, 'requestId': req['requestId']})));
      final sum = PaymentSummary(
          amountMinor: prev['amountMinor'] as int, currency: prev['currency'] as String, payerAmountMinor: prev['payerAmountMinor'] as int,
          payerCurrency: prev['payerCurrency'] as String, rateMicros: prev['rateMicros'] as int, marginBps: prev['marginBps'] as int, hash: summaryHash);
      if (!await confirm(sum)) {
        await s._sendEnc('cancel', {'requestId': req['requestId']});
        throw SwException('user_cancelled', 'el pagador canceló la operación');
      }
      final art = await agent.createPayment(pr);
      await s._sendEnc('pay_voucher', {'voucher': art.voucher, 'summaryHash': summaryHash});
      final (rt, rb) = await s._recvEnc();
      if (rt != 'pay_receipt') throw SwException('payment_rejected', 'el beneficiario rechazó el pago: ${rb['reason']}');
      return {'txId': (art.voucher['intent'] as Map)['txId'], 'voucher': art.voucher, 'entry': art.entry, 'ack': rb['ack'], 'summary': sum};
    } finally {
      await s._it.cancel();
    }
  }

  // ------------------------------------------------------------------ BENEFICIARIO
  static Future<Map<String, dynamic>> runPayee(OfflineAgent agent, PeerTransport t, {required int amountMinor, required String currency, required BiometricConfirm confirm, String channel = 'ble', String? merchantRef}) async {
    final s = SecureSession._(agent, t, 'payee');
    try {
      final peerHello = Map<String, dynamic>.from((await s._recv())['hello'] as Map);
      s.peer = await s._verifyHello(peerHello, 'payer');
      final eph = await SwCrypto.generateKeyPair();
      final myNonce = SwCrypto.randomHex(12);
      await s._send({'hello': await s._hello(eph, myNonce)});
      final sk = await s._secret(eph, peerHello['eph'] as String, peerHello['nonce'] as String, myNonce);
      s._ratchet = await RatchetSession.responder(sk, eph);
      final (rt, _) = await s._recvEnc();
      if (rt != 'ready') throw SwException('protocol', 'se esperaba ready');
      final requestId = SwCrypto.randomHex(8);
      // biometría del beneficiario sobre lo que cobra
      final preSum = PaymentSummary(amountMinor: amountMinor, currency: currency, payerAmountMinor: 0, payerCurrency: '', rateMicros: 0, marginBps: 0, hash: requestId);
      if (!await confirm(preSum)) throw SwException('user_cancelled', 'el beneficiario canceló el cobro');
      await s._sendEnc('pay_request', {'requestId': requestId, 'amountMinor': amountMinor, 'currency': currency, 'channel': channel, 'merchantRef': ?merchantRef});
      final (type, body) = await s._recvEnc();
      if (type == 'cancel') throw SwException('payer_cancelled', 'el pagador canceló');
      if (type != 'pay_voucher') throw SwException('protocol', 'se esperaba pay_voucher');
      try {
        final voucher = Map<String, dynamic>.from(body['voucher'] as Map);
        await agent.verifyIncoming(voucher, s.peer!, expectedAmountMinor: amountMinor, expectedCurrency: currency, expectedNonce: requestId);
        final acc = await agent.acceptIncoming(voucher);
        await s._sendEnc('pay_receipt', {'ack': acc.ack, 'txId': (voucher['intent'] as Map)['txId']});
        return {'txId': (voucher['intent'] as Map)['txId'], 'voucher': acc.voucher, 'entry': acc.entry};
      } on SwException catch (e) {
        await s._sendEnc('pay_reject', {'reason': e.code});
        rethrow;
      }
    } finally {
      await s._it.cancel();
    }
  }
}
