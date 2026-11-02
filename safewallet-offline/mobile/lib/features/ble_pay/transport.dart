import 'dart:async';
import 'dart:typed_data';

import '../../core/crypto/crypto.dart';
import '../../core/models.dart';

/// Canal de bytes entre dos teléfonos (BLE GATT, NFC/HCE APDU, o loopback en tests/demo).
abstract class PeerTransport {
  Future<void> send(Uint8List bytes);
  Stream<Uint8List> get incoming;
  Future<void> close();
}

/// Transporte en memoria para pruebas deterministas y la demo sin hardware.
class LoopbackTransport implements PeerTransport {
  LoopbackTransport._(this._out, this._in);
  final StreamController<Uint8List> _out;
  final StreamController<Uint8List> _in;
  bool dropNext = false;

  static (LoopbackTransport, LoopbackTransport) pair() {
    final a = StreamController<Uint8List>.broadcast(sync: true);
    final b = StreamController<Uint8List>.broadcast(sync: true);
    return (LoopbackTransport._(a, b), LoopbackTransport._(b, a));
  }

  /// Hook para simular un atacante en medio (MITM) que modifica o inspecciona los bytes.
  Uint8List Function(Uint8List)? tamper;

  @override
  Future<void> send(Uint8List bytes) async {
    if (dropNext) {
      dropNext = false;
      return;
    }
    _out.add(tamper == null ? bytes : tamper!(bytes));
  }

  @override
  Stream<Uint8List> get incoming => _in.stream;
  @override
  Future<void> close() async {
    await _out.close();
  }
}

/// Fragmentación para MTU pequeños de BLE: [seq:1][total:1][msgId:2][len:1][payload][crc16:2].
class BleFrameCodec {
  BleFrameCodec({this.mtu = 180});
  final int mtu;
  int _msgId = 0;
  final Map<int, Map<int, Uint8List>> _partial = {};
  final Map<int, int> _total = {};

  static int crc16(List<int> data) {
    var crc = 0xffff;
    for (final b in data) {
      crc ^= b << 8;
      for (var k = 0; k < 8; k++) {
        crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  List<Uint8List> split(Uint8List msg) {
    final chunk = mtu - 8;
    final total = (msg.length + chunk - 1) ~/ chunk;
    if (total > 255) throw SwException('frame_too_large', 'mensaje demasiado grande para BLE');
    final id = _msgId = (_msgId + 1) & 0xffff;
    final out = <Uint8List>[];
    for (var i = 0; i < (total == 0 ? 1 : total); i++) {
      final part = msg.sublist(i * chunk, (i + 1) * chunk > msg.length ? msg.length : (i + 1) * chunk);
      final head = [i, total, id >> 8, id & 0xff, part.length];
      final crc = crc16([...head, ...part]);
      out.add(Uint8List.fromList([...head, ...part, crc >> 8, crc & 0xff]));
    }
    return out;
  }

  /// Devuelve el mensaje completo cuando llega el último fragmento; null mientras faltan.
  Uint8List? feed(Uint8List frame) {
    if (frame.length < 7) throw SwException('frame_bad', 'fragmento truncado');
    final body = frame.sublist(0, frame.length - 2);
    final crc = (frame[frame.length - 2] << 8) | frame[frame.length - 1];
    if (crc16(body) != crc) throw SwException('frame_crc', 'fragmento corrupto (CRC)');
    final seq = frame[0], total = frame[1], id = (frame[2] << 8) | frame[3], len = frame[4];
    if (frame.length != 5 + len + 2) throw SwException('frame_bad', 'longitud inconsistente');
    final parts = _partial.putIfAbsent(id, () => {});
    _total[id] = total;
    parts[seq] = frame.sublist(5, 5 + len);
    if (parts.length < total) return null;
    final out = BytesBuilder();
    for (var i = 0; i < total; i++) {
      final p = parts[i];
      if (p == null) throw SwException('frame_missing', 'falta el fragmento $i');
      out.add(p);
    }
    _partial.remove(id);
    _total.remove(id);
    return out.toBytes();
  }
}

/// NFC / HCE (ISO 7816-4): comandos APDU para transportar mensajes entre el teléfono-POS y el teléfono-tarjeta.
class NfcApdu {
  /// AID propietario de SafeWallet (F0 + "SAFEWL").
  static final aid = Uint8List.fromList([0xF0, 0x53, 0x41, 0x46, 0x45, 0x57, 0x4C]);
  static const ins = 0xD0; // PUT DATA propietario
  static const maxData = 240;

  static Uint8List select() => Uint8List.fromList([0x00, 0xA4, 0x04, 0x00, aid.length, ...aid, 0x00]);

  static bool isSelect(Uint8List apdu) =>
      apdu.length >= 5 + aid.length && apdu[0] == 0x00 && apdu[1] == 0xA4 && apdu[2] == 0x04 && _eq(apdu.sublist(5, 5 + aid.length), aid);

  static bool _eq(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  /// Divide un mensaje en comandos APDU encadenados (P1=0x80 hay más, 0x00 último; P2 = índice).
  static List<Uint8List> command(Uint8List msg) {
    final out = <Uint8List>[];
    final n = (msg.length + maxData - 1) ~/ maxData;
    for (var i = 0; i < (n == 0 ? 1 : n); i++) {
      final part = msg.sublist(i * maxData, (i + 1) * maxData > msg.length ? msg.length : (i + 1) * maxData);
      out.add(Uint8List.fromList([0x80, ins, i == n - 1 ? 0x00 : 0x80, i & 0xff, part.length, ...part]));
    }
    return out;
  }

  /// Reensambla; devuelve el mensaje completo al recibir el último APDU. Respuesta de estado: 0x9000 OK.
  static Uint8List? reassemble(List<Uint8List> acc, Uint8List apdu) {
    if (apdu.length < 5 || apdu[0] != 0x80 || apdu[1] != ins) throw SwException('apdu_bad', 'APDU no reconocido');
    if (apdu[4] != apdu.length - 5) throw SwException('apdu_bad', 'Lc inconsistente');
    if (apdu[3] != (acc.length & 0xff)) throw SwException('apdu_order', 'APDU fuera de orden');
    acc.add(apdu.sublist(5));
    if (apdu[2] == 0x80) return null;
    final b = BytesBuilder();
    for (final p in acc) {
      b.add(p);
    }
    acc.clear();
    return b.toBytes();
  }

  static final ok = Uint8List.fromList([0x90, 0x00]);
}

String shortHash(List<int> b) => SwCrypto.hex(b.take(4).toList());
