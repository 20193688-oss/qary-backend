/// Envío de SMS con el crédito del chip (sin datos). La implementación real usa telefonía nativa
/// (SmsManager en Android); aquí se define el contrato y un registrador para tests/demo.
abstract class SmsGateway {
  Future<void> send(String to, String body);
}

class RecordingSmsGateway implements SmsGateway {
  final List<({String to, String body})> sent = [];
  @override
  Future<void> send(String to, String body) async => sent.add((to: to, body: body));
}
