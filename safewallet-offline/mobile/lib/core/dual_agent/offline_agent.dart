import 'dart:convert';

import '../../features/multi_currency/fx.dart';
import '../crypto/canonical.dart';
import '../crypto/crypto.dart';
import '../models.dart';
import '../risk.dart';
import '../secure_element/secure_element.dart';
import 'bus.dart';
import 'wal.dart';

/// Límites y listas configuradas por el usuario (precargadas, vigentes sin red).
class OfflineProfile {
  const OfflineProfile({this.dailyLimitUsdMinor = 20000, this.perTxLimitUsdMinor = 10000, this.whitelistMerchants = const [], this.countryLimitsUsdMinor = const {}, this.homeCurrency = 'PEN', this.homeCountry = 'PE'});
  final int dailyLimitUsdMinor;
  final int perTxLimitUsdMinor;
  final List<String> whitelistMerchants;
  final Map<String, int> countryLimitsUsdMinor;
  final String homeCurrency;
  final String homeCountry;

  Map<String, dynamic> toJson() => {
        'dailyLimitUsdMinor': dailyLimitUsdMinor, 'perTxLimitUsdMinor': perTxLimitUsdMinor, 'whitelistMerchants': whitelistMerchants,
        'countryLimitsUsdMinor': countryLimitsUsdMinor, 'homeCurrency': homeCurrency, 'homeCountry': homeCountry,
      };

  factory OfflineProfile.fromJson(Map<String, dynamic> j) => OfflineProfile(
        dailyLimitUsdMinor: j['dailyLimitUsdMinor'] as int, perTxLimitUsdMinor: j['perTxLimitUsdMinor'] as int,
        whitelistMerchants: List<String>.from(j['whitelistMerchants'] as List),
        countryLimitsUsdMinor: (j['countryLimitsUsdMinor'] as Map).map((k, v) => MapEntry(k as String, v as int)),
        homeCurrency: j['homeCurrency'] as String, homeCountry: j['homeCountry'] as String,
      );
}

class StepUp {
  const StepUp({required this.biometric, required this.pin});
  final bool biometric;
  final bool pin;
}

class PaymentRequest {
  const PaymentRequest({
    this.payeeDeviceId, this.payeeRef, required this.amountMinor, required this.currency, this.payerCurrency, this.channel = 'ble',
    this.merchantRef, this.country, this.nonce, this.stepUp, this.snapshotId, this.extra = const {},
  });
  final String? payeeDeviceId;
  final String? payeeRef;
  final int amountMinor;
  final String currency;
  final String? payerCurrency;
  final String channel;
  final String? merchantRef;
  final String? country;
  final String? nonce;
  final StepUp? stepUp;
  final String? snapshotId;
  final Map<String, dynamic> extra;
}

class PaymentArtifacts {
  PaymentArtifacts(this.voucher, this.entry, this.riskScore, this.usdMinor);
  final Map<String, dynamic> voucher;
  final LedgerEntry entry;
  final int riskScore;
  final int usdMinor;
}

/// Centinela-Edge: agente que vive en el dispositivo y opera SIN red.
/// Mantiene el ledger firmado/encadenado, valida y emite pagos offline y aplica los límites duros.
class OfflineAgent {
  OfflineAgent({required this.se, required this.wal, required this.bus, Clock clock = systemClock}) : _clock = clock; // ignore: prefer_initializing_formals
  final SecureElement se;
  final EncryptedWal wal;
  final EventBus bus;
  final Clock _clock;

  String? deviceId;
  DeviceCertificate? certificate;
  String? serverPublicKey;
  int keyEpoch = 1;
  OfflineProfile profile = const OfflineProfile();
  RateStore? rates;
  bool frozen = false;
  String? frozenReason;
  int _seq = -1;
  int _counter = 0;
  String _prevHash = genesisHash;
  int ackedSeq = -1;
  final List<Map<String, dynamic>> _tokens = []; // {token, expiresAt}
  final Set<String> _used = {};
  final List<LedgerEntry> _entries = [];
  bool activeRiskFlag = false;

  int now() => _clock();
  int get lastSeq => _seq;
  int get lastCounter => _counter;
  String get lastHash => _prevHash;
  List<LedgerEntry> get entries => List.unmodifiable(_entries);
  int get availableTokens => _tokens.where((t) => !_used.contains(t['token']) && (t['expiresAt'] as int) > _clock()).length;

  /// Reconstruye el estado desde el WAL cifrado (arranque en frío / reinicio de la app).
  Future<void> restore() async {
    for (final r in await wal.readAll()) {
      switch (r.kind) {
        case 'identity':
          deviceId = r.data['deviceId'] as String;
          certificate = DeviceCertificate.fromJson(Map<String, dynamic>.from(r.data['certificate'] as Map));
          serverPublicKey = r.data['serverPublicKey'] as String;
          keyEpoch = r.data['epoch'] as int;
          rates = RateStore(serverPublicKey!, clock: _clock);
        case 'epoch':
          keyEpoch = r.data['epoch'] as int;
        case 'profile':
          profile = OfflineProfile.fromJson(r.data);
        case 'rates':
          await rates!.add(RateSnapshot.fromJson(Map<String, dynamic>.from(r.data['snapshot'] as Map)));
        case 'tokens':
          for (final t in r.data['tokens'] as List) {
            _tokens.add(Map<String, dynamic>.from(t as Map));
          }
        case 'token_used':
          _used.add(r.data['token'] as String);
        case 'ledger':
          final e = LedgerEntry.fromJson(r.data);
          _entries.add(e);
          _seq = e.seq;
          _counter = e.counter;
          _prevHash = e.hash;
        case 'ack':
          ackedSeq = r.data['upToSeq'] as int;
        case 'freeze':
          frozen = true;
          frozenReason = r.data['reason'] as String?;
        case 'unfreeze':
          frozen = false;
          frozenReason = null;
        case 'revoke_tokens':
          _tokens.clear();
        case 'risk_flag':
          activeRiskFlag = r.data['active'] as bool;
      }
    }
  }

  // ---------------------------------------------------------------- aprovisionamiento
  Future<void> applyAttestation(Map<String, dynamic> resp) async {
    deviceId = resp['deviceId'] as String;
    serverPublicKey = resp['serverPublicKey'] as String;
    certificate = DeviceCertificate.fromJson(Map<String, dynamic>.from(resp['certificate'] as Map));
    if (!await SwCrypto.verify(serverPublicKey!, SwCrypto.utf8Bytes(canonicalJson(certificate!.body)), certificate!.sig) || certificate!.publicKey != se.publicKey) {
      throw SwException('cert_invalid', 'certificado de dispositivo inválido');
    }
    rates = RateStore(serverPublicKey!, clock: _clock);
    final keys = Map<String, dynamic>.from(resp['keys'] as Map);
    keyEpoch = keys['epoch'] as int;
    await wal.append('identity', {'deviceId': deviceId, 'certificate': certificate!.toJson(), 'serverPublicKey': serverPublicKey, 'epoch': keyEpoch});
    await _importKeys(keys);
    await addRates(RateSnapshot.fromJson(Map<String, dynamic>.from(resp['rates'] as Map)));
  }

  Future<void> _importKeys(Map<String, dynamic> bundle) async {
    final ep = bundle['epoch'] as int;
    await se.importKeyMap(Map<String, dynamic>.from(bundle['wrapped'] as Map), 'sw-keys|$deviceId|$ep', nameFor: (f) => f == 'ledgerKey' ? 'ledger' : (f == 'smsKey' ? 'sms' : null));
  }

  /// Rotación de claves (24 h o por evento de riesgo).
  Future<void> applyRotatedKeys(Map<String, dynamic> bundle) async {
    await _importKeys(bundle);
    keyEpoch = bundle['epoch'] as int;
    await wal.append('epoch', {'epoch': keyEpoch});
  }

  Future<void> applyTokens(Map<String, dynamic> resp) async {
    await se.importKeyMap(Map<String, dynamic>.from(resp['lukBundle'] as Map), 'sw-luk|$deviceId', nameFor: (f) => 'luk:$f');
    final toks = (resp['tokens'] as List).map((t) => {'token': (t as Map)['token'], 'expiresAt': t['expiresAt']}).toList();
    _tokens.addAll(toks.map((t) => Map<String, dynamic>.from(t)));
    await wal.append('tokens', {'tokens': toks});
  }

  Future<void> setProfile(OfflineProfile p) async {
    profile = p;
    await wal.append('profile', p.toJson());
  }

  Future<void> addRates(RateSnapshot s) async {
    await rates!.add(s);
    await wal.append('rates', {'snapshot': s.toJson()});
    bus.publish(RatesUpdated(s.id));
  }

  Future<void> setRiskFlag(bool active) async {
    activeRiskFlag = active;
    await wal.append('risk_flag', {'active': active});
  }

  // ---------------------------------------------------------------- ledger
  Future<LedgerEntry> _append(String type, Map<String, dynamic> payload, {int? counter}) async {
    final seq = _seq + 1;
    final ctr = counter ?? (_counter + 1);
    final base = {'seq': seq, 'counter': ctr, 'prevHash': _prevHash, 'keyEpoch': keyEpoch, 'type': type, 'payload': payload};
    final hash = await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(canonicalJson(base)));
    final e = LedgerEntry(
        seq: seq, counter: ctr, prevHash: _prevHash, keyEpoch: keyEpoch, type: type, payload: payload, hash: hash,
        mac: await se.hmacHex('ledger', SwCrypto.utf8Bytes(hash)), sig: await se.sign(SwCrypto.utf8Bytes(hash)));
    await wal.append('ledger', e.toJson());
    _entries.add(e);
    _seq = seq;
    _counter = ctr;
    _prevHash = hash;
    bus.publish(LedgerAppended(seq, type));
    return e;
  }

  /// Verifica cadena hash+MAC+firma del ledger local (autoauditoría anti-tampering).
  Future<int> verifyLocalLedger() async {
    var prev = genesisHash;
    for (final e in _entries) {
      final base = {'seq': e.seq, 'counter': e.counter, 'prevHash': e.prevHash, 'keyEpoch': e.keyEpoch, 'type': e.type, 'payload': e.payload};
      final h = await SwCrypto.sha256Hex(SwCrypto.utf8Bytes(canonicalJson(base)));
      if (e.prevHash != prev || e.hash != h || !SwCrypto.constantTimeEquals(e.mac, await se.hmacHex('ledger', SwCrypto.utf8Bytes(h))) || !await SwCrypto.verify(se.publicKey, SwCrypto.utf8Bytes(h), e.sig)) {
        return e.seq;
      }
      prev = e.hash;
    }
    return -1;
  }

  List<LedgerEntry> pendingEntries() => _entries.where((e) => e.seq > ackedSeq).toList();

  Future<void> markReconciled(int upToSeq) async {
    if (upToSeq > ackedSeq) {
      ackedSeq = upToSeq;
      await wal.append('ack', {'upToSeq': upToSeq});
    }
  }

  // ---------------------------------------------------------------- congelamiento / escudo
  Future<void> freeze(String reason) async {
    frozen = true;
    frozenReason = reason;
    await wal.append('freeze', {'reason': reason});
  }

  Future<void> unfreeze() async {
    frozen = false;
    frozenReason = null;
    await wal.append('unfreeze', {});
  }

  Future<void> revokeAllTokens() async {
    _tokens.clear();
    await wal.append('revoke_tokens', {});
  }

  // ---------------------------------------------------------------- pagos
  int _hourLocal() => DateTime.fromMillisecondsSinceEpoch(_clock(), isUtc: true).subtract(const Duration(hours: 5)).hour;

  int _usedTodayUsd(int ts) {
    final day = DateTime.fromMillisecondsSinceEpoch(ts, isUtc: true).toIso8601String().substring(0, 10);
    var sum = 0;
    for (final e in _entries) {
      if (e.type != 'PAY_OUT' && !(e.type == 'NOTE' && e.payload['kind'] == 'sms_payment')) continue;
      final t = e.payload['ts'] as int? ?? ((e.payload['voucher'] as Map?)?['intent'] as Map?)?['ts'] as int?;
      if (t == null) continue;
      if (DateTime.fromMillisecondsSinceEpoch(t, isUtc: true).toIso8601String().substring(0, 10) == day) sum += e.payload['usdMinor'] as int? ?? 0;
    }
    return sum;
  }

  int _txLastHour(int ts) => _entries.where((e) => e.type == 'PAY_OUT' && (((e.payload['voucher'] as Map)['intent'] as Map)['ts'] as int) > ts - 3600000).length;

  String _nextToken() {
    final now = _clock();
    for (final t in _tokens) {
      if (!_used.contains(t['token']) && (t['expiresAt'] as int) > now) return t['token'] as String;
    }
    throw NoTokensAvailable();
  }

  Future<String> _arqc(String token, int amountMinor, String currency, int counter, String txId) async {
    final data = canonicalJson({'token': token, 'amountMinor': amountMinor, 'currency': currency, 'counter': counter, 'txId': txId});
    return (await se.hmacHex('luk:$token', SwCrypto.utf8Bytes(data))).substring(0, 32);
  }

  /// Límite duro: el agente offline JAMÁS puede exceder los límites precargados (anti doble gasto).
  Future<({int usd, int price, int rate, int margin, RateSnapshot snap, int score, String payerCurrency})> _assess(PaymentRequest r, {required String channel}) async {
    if (frozen) throw DeviceFrozen();
    if (se.isWiped) throw DeviceFrozen();
    if (!supportedCurrencies.contains(r.currency)) throw SwException('invalid_currency', 'moneda no soportada: ${r.currency}');
    if (r.amountMinor <= 0) throw SwException('invalid_amount', 'monto inválido');
    final payerCur = r.payerCurrency ?? profile.homeCurrency;
    final snap = r.snapshotId != null ? (rates!.byId(r.snapshotId!) ?? (throw SwException('rates_unknown', 'snapshot ${r.snapshotId} no está precargado'))) : rates!.requireFresh();
    final rate = snap.crossRateMicros(payerCur, r.currency);
    final margin = r.currency == payerCur ? 0 : snap.marginBps;
    final price = payerPriceMinor(r.amountMinor, rate, margin);
    final usd = snap.toUsdMinor(payerCur, price);
    final unlisted = r.merchantRef != null && !profile.whitelistMerchants.contains(r.merchantRef);
    final perTx = unlisted ? profile.perTxLimitUsdMinor ~/ 4 : profile.perTxLimitUsdMinor;
    if (usd > perTx) throw OfflineLimitExceeded('monto USD ${(usd / 100).toStringAsFixed(2)} supera el límite por operación offline (${(perTx / 100).toStringAsFixed(2)})');
    final cl = r.country == null ? null : profile.countryLimitsUsdMinor[r.country];
    if (cl != null && usd > cl) throw OfflineLimitExceeded('supera el límite para ${r.country}');
    final now = _clock();
    final used = _usedTodayUsd(now);
    if (used + usd > profile.dailyLimitUsdMinor) {
      throw OfflineLimitExceeded('supera el límite diario offline (${(profile.dailyLimitUsdMinor / 100).toStringAsFixed(2)} USD)');
    }
    final score = riskScore(RiskInput(
        amountUsdMinor: usd, perTxLimitUsdMinor: profile.perTxLimitUsdMinor, dailyLimitUsdMinor: profile.dailyLimitUsdMinor, dailyUsedUsdMinor: used,
        txLastHour: _txLastHour(now), merchantUnlisted: unlisted, foreign: r.country != null && r.country != profile.homeCountry, hourLocal: _hourLocal(),
        channel: channel, activeRiskFlag: activeRiskFlag));
    if (score > 70 && !(r.stepUp?.biometric == true && r.stepUp?.pin == true)) throw StepUpRequired(score);
    return (usd: usd, price: price, rate: rate, margin: margin, snap: snap, score: score, payerCurrency: payerCur);
  }

  /// Evalúa un pago sin ejecutarlo (para mostrar al usuario monto, tasa y hash antes de la biometría).
  Future<Map<String, dynamic>> preview(PaymentRequest r) async {
    final a = await _assess(r, channel: r.channel);
    return {'amountMinor': r.amountMinor, 'currency': r.currency, 'payerAmountMinor': a.price, 'payerCurrency': a.payerCurrency, 'rateMicros': a.rate, 'marginBps': a.margin, 'rateSnapshotId': a.snap.id, 'riskScore': a.score};
  }

  Future<PaymentArtifacts> createPayment(PaymentRequest r) async {
    final a = await _assess(r, channel: r.channel);
    final token = _nextToken();
    final counter = _counter + 1;
    final txId = SwCrypto.randomHex(12);
    final now = _clock();
    final intent = <String, dynamic>{
      'txId': txId, 'payerDeviceId': deviceId, if (r.payeeDeviceId != null) 'payeeDeviceId': r.payeeDeviceId, if (r.payeeRef != null) 'payeeRef': r.payeeRef,
      if (r.merchantRef != null) 'merchantRef': r.merchantRef, 'amountMinor': r.amountMinor, 'currency': r.currency, 'payerAmountMinor': a.price,
      'payerCurrency': a.payerCurrency, 'rateMicros': a.rate, 'marginBps': a.margin, 'rateSnapshotId': a.snap.id, 'token': token,
      'arqc': await _arqc(token, r.amountMinor, r.currency, counter, txId), 'counter': counter, 'channel': r.channel, 'ts': now,
      'nonce': r.nonce ?? SwCrypto.randomHex(8), 'keyEpoch': keyEpoch,
      if (r.country != null) 'geo': {'country': r.country},
      if (r.stepUp != null)
        'stepUp': {
          'biometric': r.stepUp!.biometric, 'pin': r.stepUp!.pin,
          if (a.score > 70) 'smsProof': (await se.hmacHex('sms', SwCrypto.utf8Bytes(txId))).substring(0, 16),
        },
      ...r.extra,
    };
    final voucher = <String, dynamic>{'intent': intent, 'payerSig': await se.sign(SwCrypto.utf8Bytes(canonicalJson(intent)))};
    _used.add(token);
    await wal.append('token_used', {'token': token});
    final e = await _append('PAY_OUT', {'voucher': voucher, 'usdMinor': a.usd}, counter: counter);
    return PaymentArtifacts(voucher, e, a.score, a.usd);
  }

  /// Lado beneficiario: valida el voucher del pagador SIN red (certificado del servidor + firma ECDSA + coherencia de montos y tasa).
  Future<Map<String, dynamic>> verifyIncoming(Map<String, dynamic> voucher, DeviceCertificate payerCert, {required int expectedAmountMinor, required String expectedCurrency, String? expectedNonce}) async {
    final intent = Map<String, dynamic>.from(voucher['intent'] as Map);
    if (!await SwCrypto.verify(serverPublicKey!, SwCrypto.utf8Bytes(canonicalJson(payerCert.body)), payerCert.sig)) throw SwException('payer_cert_invalid', 'certificado del pagador no firmado por el servidor');
    if (payerCert.expiresAt < _clock()) throw SwException('payer_cert_expired', 'licencia del dispositivo pagador vencida');
    if (intent['payerDeviceId'] != payerCert.deviceId) throw SwException('payer_mismatch', 'el voucher no corresponde al certificado');
    if (!await SwCrypto.verify(payerCert.publicKey, SwCrypto.utf8Bytes(canonicalJson(intent)), voucher['payerSig'] as String)) throw SwException('payer_sig_invalid', 'firma del pagador inválida');
    if (intent['payeeDeviceId'] != deviceId) throw SwException('wrong_payee', 'el voucher es para otro beneficiario');
    if (intent['amountMinor'] != expectedAmountMinor || intent['currency'] != expectedCurrency) throw SwException('amount_mismatch', 'monto/moneda distintos a lo solicitado');
    if (expectedNonce != null && intent['nonce'] != expectedNonce) throw SwException('nonce_mismatch', 'nonce distinto');
    final snap = rates?.byId(intent['rateSnapshotId'] as String);
    if (snap != null) {
      final rate = intent['currency'] == intent['payerCurrency'] ? 1000000 : snap.crossRateMicros(intent['payerCurrency'] as String, intent['currency'] as String);
      if (intent['rateMicros'] != rate || intent['payerAmountMinor'] != payerPriceMinor(intent['amountMinor'] as int, rate, intent['marginBps'] as int) || (intent['marginBps'] as int) > snap.marginBps) {
        throw SwException('rate_mismatch', 'tasa o precio inconsistentes con el snapshot firmado');
      }
    }
    return intent;
  }

  /// Confirma recepción: contrafirma (ack) y registra PAY_IN en el ledger del beneficiario.
  Future<({Map<String, dynamic> voucher, LedgerEntry entry, Map<String, dynamic> ack})> acceptIncoming(Map<String, dynamic> voucher) async {
    if (frozen) throw DeviceFrozen();
    final txId = (voucher['intent'] as Map)['txId'] as String;
    final ack = {'payeeDeviceId': deviceId, 'sig': await se.sign(SwCrypto.utf8Bytes(canonicalJson({'txId': txId, 'payeeDeviceId': deviceId})))};
    final v = {...voucher, 'payeeAck': ack};
    final e = await _append('PAY_IN', {'voucher': v});
    return (voucher: v, entry: e, ack: ack);
  }

  // ---------------------------------------------------------------- SMS (solo línea celular)
  /// Prepara un pago SWPAY1 (el voucher completo no cabe en un SMS: el servidor reconstruye el intent).
  Future<Map<String, dynamic>> prepareSmsPayment({required String payeePhone, required int amountMinor, required String currency, String? payerCurrency, String? country, StepUp? stepUp}) async {
    final r = PaymentRequest(amountMinor: amountMinor, currency: currency, payerCurrency: payerCurrency, channel: 'sms', country: country, stepUp: stepUp);
    final a = await _assess(r, channel: 'sms');
    final token = _nextToken();
    final counter = _counter + 1;
    final txId = SwCrypto.randomHex(6);
    final now = _clock();
    final payload = {
      't': txId, 'to': payeePhone, 'a': amountMinor, 'c': currency, 'pc': a.payerCurrency, 's': a.snap.id, 'm': a.margin, 'k': token,
      'q': await _arqc(token, amountMinor, currency, counter, txId), 'n': counter, 'ts': now, 'g': ?country, 'e': keyEpoch,
    };
    _used.add(token);
    await wal.append('token_used', {'token': token});
    await _append('NOTE', {'kind': 'sms_payment', 'txId': txId, 'to': payeePhone, 'amountMinor': amountMinor, 'currency': currency, 'ts': now, 'usdMinor': a.usd}, counter: counter);
    return payload;
  }

  Future<Map<String, String>> sealForSms(List<int> plain, {required String aad}) => se.aeadEncrypt('sms', plain, aad: aad);

  String get statusJson => jsonEncode({'deviceId': deviceId, 'seq': _seq, 'counter': _counter, 'frozen': frozen, 'tokens': availableTokens});
}
