import 'package:flutter/material.dart';

import '../core/panic/pin_vault.dart';
import '../core/panic/shield.dart';
import '../features/qr_interop/emv_qr.dart';
import 'app_controller.dart';

final _emvDemo = EmvQr.build(dynamic: true, guid: 'pe.com.yape', account: '999888777', currencyNumeric: '604', amount: '12.50', country: 'PE', name: 'TAXI LIMA', city: 'LIMA');

class SafeWalletApp extends StatelessWidget {
  const SafeWalletApp({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'SafeWallet Offline',
        theme: ThemeData(colorSchemeSeed: const Color(0xFF0B6E4F), useMaterial3: true),
        home: ListenableBuilder(
          listenable: controller,
          builder: (_, _) => switch (controller.stage) {
            Stage.onboarding => OnboardingScreen(controller: controller),
            _ => HomeScreen(controller: controller),
          },
        ),
      );
}

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, required this.controller});
  final AppController controller;
  @override
  State<OnboardingScreen> createState() => _OnboardingState();
}

class _OnboardingState extends State<OnboardingScreen> {
  final url = TextEditingController(text: const String.fromEnvironment('SW_API_URL', defaultValue: 'http://10.0.2.2:3000'));
  final key = TextEditingController(text: const String.fromEnvironment('SW_API_KEY', defaultValue: 'sw_sandbox_demo_key'));
  final phone = TextEditingController(text: '+51999000111');
  final pin = TextEditingController();
  final duress = TextEditingController();
  final pan = TextEditingController(text: '4111111111111111');
  final contactName = TextEditingController(text: 'Mamá');
  final contactPhone = TextEditingController(text: '+51999111000');
  String? error;

  String? _validate() {
    if (!RegExp(r'^\d{4,8}$').hasMatch(pin.text)) return 'El PIN debe tener 4 a 8 dígitos';
    if (!RegExp(r'^\d{4,8}$').hasMatch(duress.text)) return 'El PIN de coacción debe tener 4 a 8 dígitos';
    if (pin.text == duress.text) return 'El PIN de coacción debe ser distinto del PIN real';
    if (!RegExp(r'^\+\d{8,15}$').hasMatch(phone.text)) return 'Teléfono en formato +51999999999';
    if (!RegExp(r'^\+\d{8,15}$').hasMatch(contactPhone.text)) return 'Teléfono del contacto de confianza inválido';
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return Scaffold(
      appBar: AppBar(title: const Text('SafeWallet Offline — Activación')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Text('Tu billetera sigue funcionando sin internet y se protege sola si te roban.'),
        const SizedBox(height: 12),
        TextField(key: const Key('url'), controller: url, decoration: const InputDecoration(labelText: 'URL del backend')),
        TextField(controller: key, decoration: const InputDecoration(labelText: 'API key (sandbox)')),
        TextField(key: const Key('phone'), controller: phone, decoration: const InputDecoration(labelText: 'Tu teléfono (E.164)')),
        TextField(key: const Key('pin'), controller: pin, obscureText: true, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'PIN (4-8 dígitos)')),
        TextField(key: const Key('duress'), controller: duress, obscureText: true, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'PIN de coacción (abre una billetera señuelo)')),
        TextField(controller: pan, decoration: const InputDecoration(labelText: 'Tarjeta a tokenizar (PAN de prueba)')),
        Row(children: [
          Expanded(child: TextField(controller: contactName, decoration: const InputDecoration(labelText: 'Contacto de confianza'))),
          const SizedBox(width: 8),
          Expanded(child: TextField(controller: contactPhone, decoration: const InputDecoration(labelText: 'Su teléfono'))),
        ]),
        if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, key: const Key('error'), style: const TextStyle(color: Colors.red))),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('activate'),
          onPressed: c.busy
              ? null
              : () async {
                  final v = _validate();
                  setState(() => error = v);
                  if (v != null) return;
                  await c.onboard(
                      apiUrl: url.text, apiKey: key.text, phone: phone.text, pin: pin.text, duressPin: duress.text, pan: pan.text,
                      contacts: [TrustedContact(contactName.text, contactPhone.text)]);
                },
          child: Text(c.busy ? 'Activando…' : 'Activar'),
        ),
        for (final l in c.log.take(5)) Text(l.text, style: TextStyle(color: l.error ? Colors.red : null)),
      ]),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final shielded = c.stage == Stage.shielded;
    return Scaffold(
      appBar: AppBar(title: Text(shielded ? 'ESCUDO ACTIVO' : 'SafeWallet'), backgroundColor: shielded ? Colors.red.shade700 : null, foregroundColor: shielded ? Colors.white : null),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        if (shielded)
          const Card(color: Color(0xFFFFEBEE), child: Padding(padding: EdgeInsets.all(12), child: Text('Protocolo Escudo activado: claves borradas, tokens revocados y contactos avisados. No se puede pagar desde este teléfono.', key: Key('shield-banner')))),
        Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Saldos', style: TextStyle(fontWeight: FontWeight.bold)),
          if (c.balances.isEmpty) const Text('Sin saldo'),
          for (final e in c.balances.entries) Text('${e.key}: ${((e.value as int) / 100).toStringAsFixed(2)}', key: Key('bal-${e.key}')),
          Text(c.offline == null ? '' : 'Tokens offline: ${c.offline!.availableTokens} · Pendientes de conciliar: ${c.offline!.pendingEntries().length}${c.offline!.frozen ? ' · CONGELADO' : ''}'),
        ]))),
        if (!shielded) ...[
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton(key: const Key('top-up'), onPressed: c.busy ? null : () => c.topUpSandbox(100000), child: const Text('Recargar S/ 1000 (sandbox)')),
            FilledButton(key: const Key('pay-ble'), onPressed: c.busy ? null : () => c.payNearby(amountMinor: 1200, currency: 'USD', nfc: false), child: const Text('Pagar US\$ 12 · Bluetooth')),
            FilledButton(key: const Key('pay-nfc'), onPressed: c.busy ? null : () => c.payNearby(amountMinor: 1500, currency: 'PEN', nfc: true), child: const Text('Pagar S/ 15 · NFC')),
            FilledButton(key: const Key('pay-qr'), onPressed: c.busy ? null : () => c.payQr(amountMinor: 800, currency: 'USD'), child: const Text('Pagar QR dinámico')),
            FilledButton(key: const Key('pay-emv'), onPressed: c.busy ? null : () => c.payEmv(_emvDemo, online: false), child: const Text('Pagar QR Yape (sin red)')),
            FilledButton(key: const Key('pay-sms'), onPressed: c.busy ? null : () => c.paySms(payeePhone: '999000222', amountMinor: 1800), child: const Text('Pagar por SMS')),
            OutlinedButton(key: const Key('sync'), onPressed: c.busy ? null : c.syncNow, child: const Text('Recuperé red: sincronizar')),
          ]),
          const SizedBox(height: 12),
          OutlinedButton(key: const Key('duress-login'), onPressed: () => _askPin(context, c), child: const Text('Re-autenticar con PIN')),
        ],
        const SizedBox(height: 24),
        // Botón de pánico: mantener presionado 1 s. Activa el Escudo completo en < 3 s sin red.
        GestureDetector(
          key: const Key('panic'),
          onLongPress: shielded || c.busy ? null : () => c.panic(),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 22),
            decoration: BoxDecoration(color: shielded ? Colors.grey : Colors.red.shade700, borderRadius: BorderRadius.circular(16)),
            child: Center(child: Text(shielded ? 'ESCUDO ACTIVADO' : 'PÁNICO — mantén presionado', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold))),
          ),
        ),
        const SizedBox(height: 16),
        const Text('Actividad', style: TextStyle(fontWeight: FontWeight.bold)),
        for (final l in c.log.take(30)) Text('• ${l.text}', style: TextStyle(color: l.error ? Colors.red : null, fontSize: 12)),
      ]),
    );
  }

  Future<void> _askPin(BuildContext context, AppController c) async {
    final t = TextEditingController();
    final pin = await showDialog<String>(
        context: context,
        builder: (_) => AlertDialog(title: const Text('Ingresa tu PIN'), content: TextField(key: const Key('pin-dialog'), controller: t, obscureText: true, keyboardType: TextInputType.number), actions: [TextButton(onPressed: () => Navigator.pop(context, t.text), child: const Text('OK'))]));
    if (pin == null) return;
    final r = await c.unlockWithPin(pin);
    if (r == PinResult.wrong || r == PinResult.locked) {
      c.note(r == PinResult.locked ? 'Demasiados intentos: bloqueado 15 min' : 'PIN incorrecto', error: true);
    }
  }
}
