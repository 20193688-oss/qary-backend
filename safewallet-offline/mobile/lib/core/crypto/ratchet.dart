import 'dart:convert';
import 'dart:typed_data';

import '../models.dart';
import 'crypto.dart';

/// Double Ratchet (estilo Signal) sobre P-256 + HKDF + AES-256-GCM para las sesiones Bluetooth/NFC.
/// Cada mensaje usa una clave nueva (forward secrecy); la clave se destruye tras usarse (anti-replay).
class RatchetSession {
  RatchetSession._(this._rk, this._dhs, this._dhr, this._cks, this._ckr);

  Uint8List _rk;
  SwKeyPair _dhs;
  String? _dhr;
  Uint8List? _cks, _ckr;
  int _ns = 0, _nr = 0, _pn = 0;
  final Map<String, Uint8List> _skipped = {};
  static const maxSkip = 50;

  /// Quien inicia conoce la clave de ratchet pública del respondedor.
  static Future<RatchetSession> initiator(Uint8List sharedSecret, String responderRatchetPublic) async {
    final dhs = await SwCrypto.generateKeyPair();
    final (rk, cks) = await _kdfRk(sharedSecret, await SwCrypto.ecdh(dhs, responderRatchetPublic));
    return RatchetSession._(rk, dhs, responderRatchetPublic, cks, null);
  }

  static Future<RatchetSession> responder(Uint8List sharedSecret, SwKeyPair ratchetKeyPair) async =>
      RatchetSession._(sharedSecret, ratchetKeyPair, null, null, null);

  static Future<(Uint8List, Uint8List)> _kdfRk(Uint8List rk, Uint8List dh) async {
    final out = await SwCrypto.hkdf(dh, rk, 'sw-ratchet-rk', 64);
    return (Uint8List.fromList(out.sublist(0, 32)), Uint8List.fromList(out.sublist(32)));
  }

  static Future<(Uint8List, Uint8List)> _kdfCk(Uint8List ck) async {
    final mk = SwCrypto.unhex(await SwCrypto.hmacHex(ck, [1]));
    final next = SwCrypto.unhex(await SwCrypto.hmacHex(ck, [2]));
    return (mk, next);
  }

  Future<Map<String, dynamic>> encrypt(List<int> plaintext, {String aad = ''}) async {
    if (_cks == null) throw SwException('ratchet_no_send_chain', 'la cadena de envío aún no existe: espera el primer mensaje del iniciador');
    final (mk, next) = await _kdfCk(_cks!);
    _cks = next;
    final header = {'dh': _dhs.publicRaw, 'pn': _pn, 'n': _ns};
    _ns++;
    final key = await SwCrypto.hkdf(mk, const [], 'sw-ratchet-mk');
    final sealed = await SwCrypto.aesEncrypt(key, plaintext, aad: '$aad|${jsonEncode(header)}');
    return {...header, ...sealed};
  }

  Future<Uint8List> decrypt(Map<String, dynamic> msg, {String aad = ''}) async {
    final header = {'dh': msg['dh'], 'pn': msg['pn'], 'n': msg['n']};
    final id = '${msg['dh']}|${msg['n']}';
    final skipped = _skipped.remove(id);
    if (skipped != null) return _open(skipped, msg, aad, header);
    if (msg['dh'] != _dhr) {
      await _skipUntil(msg['pn'] as int);
      await _dhStep(msg['dh'] as String);
    }
    final n = msg['n'] as int;
    if (n < _nr) throw SwException('ratchet_replay', 'mensaje repetido o ya consumido');
    await _skipUntil(n);
    final (mk, next) = await _kdfCk(_ckr!);
    _ckr = next;
    _nr++;
    return _open(mk, msg, aad, header);
  }

  Future<Uint8List> _open(Uint8List mk, Map<String, dynamic> msg, String aad, Map<String, dynamic> header) async {
    final key = await SwCrypto.hkdf(mk, const [], 'sw-ratchet-mk');
    try {
      return await SwCrypto.aesDecrypt(key, msg, aad: '$aad|${jsonEncode(header)}');
    } catch (e) {
      throw SwException('ratchet_auth_failed', 'mensaje no autenticado (manipulado o fuera de sesión)', e);
    }
  }

  Future<void> _skipUntil(int until) async {
    if (_ckr == null) return;
    if (until - _nr > maxSkip) throw SwException('ratchet_too_many_skipped', 'demasiados mensajes omitidos');
    while (_nr < until) {
      final (mk, next) = await _kdfCk(_ckr!);
      _ckr = next;
      _skipped['$_dhr|$_nr'] = mk;
      _nr++;
    }
  }

  Future<void> _dhStep(String newRemote) async {
    _pn = _ns;
    _ns = 0;
    _nr = 0;
    _dhr = newRemote;
    var (rk, ckr) = await _kdfRk(_rk, await SwCrypto.ecdh(_dhs, newRemote));
    _ckr = ckr;
    _dhs = await SwCrypto.generateKeyPair();
    final (rk2, cks) = await _kdfRk(rk, await SwCrypto.ecdh(_dhs, newRemote));
    _rk = rk2;
    _cks = cks;
  }
}
