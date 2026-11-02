import 'dart:convert';
import 'dart:io';

import '../models.dart';
import '../secure_element/secure_element.dart';

/// Almacén de líneas (append-only). Implementaciones: memoria (tests) y archivo (dispositivo).
abstract class BlobStore {
  Future<List<String>> readLines();
  Future<void> appendLine(String line);
  Future<void> replaceAll(List<String> lines);
}

class MemoryBlobStore implements BlobStore {
  final List<String> lines = [];
  @override
  Future<List<String>> readLines() async => List.of(lines);
  @override
  Future<void> appendLine(String line) async => lines.add(line);
  @override
  Future<void> replaceAll(List<String> l) async {
    lines
      ..clear()
      ..addAll(l);
  }
}

class FileBlobStore implements BlobStore {
  FileBlobStore(this.path);
  final String path;
  File get _f => File(path);
  @override
  Future<List<String>> readLines() async => await _f.exists() ? (await _f.readAsLines()).where((l) => l.isNotEmpty).toList() : [];
  @override
  Future<void> appendLine(String line) async {
    await _f.parent.create(recursive: true);
    await _f.writeAsString('$line\n', mode: FileMode.append, flush: true);
  }

  @override
  Future<void> replaceAll(List<String> l) async {
    await _f.parent.create(recursive: true);
    final tmp = File('$path.tmp');
    await tmp.writeAsString(l.isEmpty ? '' : '${l.join('\n')}\n', flush: true);
    await tmp.rename(path);
  }
}

/// Write-Ahead Log cifrado con AES-256-GCM; la clave 'wal' vive dentro del Secure Element.
/// Cada registro lleva su índice como AAD: reordenar o mover registros invalida la autenticación.
class EncryptedWal {
  EncryptedWal(this.store, this.se, {this.keyName = 'wal'});
  final BlobStore store;
  final SecureElement se;
  final String keyName;

  Future<int> append(String kind, Map<String, dynamic> data) async {
    final idx = (await store.readLines()).length;
    final plain = utf8.encode(jsonEncode({'kind': kind, 'data': data}));
    final sealed = await se.aeadEncrypt(keyName, plain, aad: 'wal|$idx');
    await store.appendLine(jsonEncode(sealed));
    return idx;
  }

  Future<List<WalRecord>> readAll() async {
    final out = <WalRecord>[];
    final lines = await store.readLines();
    for (var i = 0; i < lines.length; i++) {
      try {
        final plain = await se.aeadDecrypt(keyName, jsonDecode(lines[i]) as Map<String, dynamic>, aad: 'wal|$i');
        final j = jsonDecode(utf8.decode(plain)) as Map<String, dynamic>;
        out.add(WalRecord(i, j['kind'] as String, Map<String, dynamic>.from(j['data'] as Map)));
      } catch (e) {
        throw SwException('wal_corrupt', 'registro $i del WAL ilegible o manipulado', e);
      }
    }
    return out;
  }
}

class WalRecord {
  const WalRecord(this.index, this.kind, this.data);
  final int index;
  final String kind;
  final Map<String, dynamic> data;
}
