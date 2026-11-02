import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models.dart';

/// Cliente del backend SafeWallet. Toda falla de red/HTTP se convierte en [SwException] con contexto
/// (nunca se traga ni se registra en silencio).
abstract class BackendApi {
  Future<Map<String, dynamic>> request(String method, String path, [Map<String, dynamic>? body]);
}

class HttpBackendApi implements BackendApi {
  HttpBackendApi({required this.baseUrl, required this.apiKey, http.Client? client, this.timeout = const Duration(seconds: 10)}) : _client = client ?? http.Client();
  final String baseUrl;
  final String apiKey;
  final Duration timeout;
  final http.Client _client;

  @override
  Future<Map<String, dynamic>> request(String method, String path, [Map<String, dynamic>? body]) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = {'x-api-key': apiKey, 'content-type': 'application/json'};
    http.Response res;
    try {
      final enc = body == null ? null : jsonEncode(body);
      res = switch (method) {
        'GET' => await _client.get(uri, headers: headers).timeout(timeout),
        'POST' => await _client.post(uri, headers: headers, body: enc ?? '{}').timeout(timeout),
        'PUT' => await _client.put(uri, headers: headers, body: enc ?? '{}').timeout(timeout),
        _ => throw ArgumentError('método no soportado: $method'),
      };
    } on TimeoutException catch (e) {
      throw SwException('network_timeout', 'tiempo de espera agotado en $method $path', e);
    } catch (e) {
      throw SwException('network_unreachable', 'sin conexión con el backend ($method $path): $e', e);
    }
    Map<String, dynamic> json;
    try {
      json = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    } catch (e) {
      throw SwException('bad_response', 'respuesta no JSON de $path (HTTP ${res.statusCode})', e);
    }
    if (res.statusCode >= 400) {
      final err = (json['error'] as Map?) ?? {};
      throw SwException(err['code'] as String? ?? 'http_${res.statusCode}', err['message'] as String? ?? 'error HTTP ${res.statusCode}', err['details']);
    }
    return json;
  }

  void close() => _client.close();
}
