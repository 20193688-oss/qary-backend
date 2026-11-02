import 'dart:io';

/// Sondas de plataforma. La implementación por defecto usa heurísticas de archivos/puertos reales de Android;
/// una implementación nativa (Play Integrity / App Attest / firma del APK) puede inyectarse sin cambiar el resto.
abstract class PlatformProbe {
  Future<bool> hasRootIndicators();
  Future<bool> looksLikeEmulator();
  Future<bool> hasHookingFramework();
  bool isDebuggable();
  Future<String?> appSignatureSha256();
}

class IntegrityReport {
  const IntegrityReport({required this.rooted, required this.emulator, required this.hooked, required this.debuggable, required this.tampered, required this.reasons});
  final bool rooted, emulator, hooked, debuggable, tampered;
  final List<String> reasons;
  bool get trusted => !rooted && !emulator && !hooked && !debuggable && !tampered;
}

class DefaultPlatformProbe implements PlatformProbe {
  DefaultPlatformProbe({this.fridaPorts = const [27042, 27043], this.mapsPath = '/proc/self/maps', this.extraRootPaths = const []});
  final List<int> fridaPorts;
  final String mapsPath;
  final List<String> extraRootPaths;

  static const _rootPaths = ['/system/bin/su', '/system/xbin/su', '/sbin/su', '/system/app/Superuser.apk', '/data/adb/magisk', '/sbin/.magisk', '/system/xbin/daemonsu'];
  static const _emuPaths = ['/dev/qemu_pipe', '/dev/socket/qemud', '/sys/qemu_trace', '/system/lib/libc_malloc_debug_qemu.so', '/dev/goldfish_pipe'];
  static const _hookNeedles = ['frida', 'xposed', 'substrate', 'lsposed', 'gum-js-loop'];

  @override
  Future<bool> hasRootIndicators() async {
    for (final p in [..._rootPaths, ...extraRootPaths]) {
      if (await File(p).exists() || await Directory(p).exists()) return true;
    }
    return false;
  }

  @override
  Future<bool> looksLikeEmulator() async {
    for (final p in _emuPaths) {
      if (await File(p).exists()) return true;
    }
    return false;
  }

  @override
  Future<bool> hasHookingFramework() async {
    // 1) frida-server escuchando en loopback
    for (final port in fridaPorts) {
      try {
        final s = await Socket.connect(InternetAddress.loopbackIPv4, port, timeout: const Duration(milliseconds: 200));
        s.destroy();
        return true;
      } catch (_) {/* puerto cerrado: esperado */}
    }
    // 2) librerías de hooking mapeadas en el propio proceso
    try {
      final f = File(mapsPath);
      if (await f.exists()) {
        final maps = (await f.readAsString()).toLowerCase();
        if (_hookNeedles.any(maps.contains)) return true;
      }
    } on FileSystemException {/* /proc no legible: no es indicador */}
    return false;
  }

  @override
  bool isDebuggable() {
    var d = false;
    assert(() {
      d = true;
      return true;
    }());
    return d;
  }

  @override
  Future<String?> appSignatureSha256() async => null; // requiere canal nativo (PackageManager.signingInfo / App Attest)
}

/// Defensa en profundidad anti-reversa: emuladores, root, hooks (Frida/Xposed/Magisk), build manipulado.
/// Ninguna app es 100 % incopiable; esto sube el costo del ataque y alimenta la attestation del servidor.
class IntegrityGuard {
  IntegrityGuard({required this.probe, this.expectedSignatureSha256, this.requireSignature = false, this.allowDebuggable = false});
  final PlatformProbe probe;
  final String? expectedSignatureSha256;
  final bool requireSignature;
  final bool allowDebuggable;

  Future<IntegrityReport> evaluate() async {
    final reasons = <String>[];
    final rooted = await probe.hasRootIndicators();
    final emu = await probe.looksLikeEmulator();
    final hooked = await probe.hasHookingFramework();
    final dbg = !allowDebuggable && probe.isDebuggable();
    var tampered = false;
    final sig = await probe.appSignatureSha256();
    if (expectedSignatureSha256 != null && sig != null && sig.toLowerCase() != expectedSignatureSha256!.toLowerCase()) tampered = true;
    if (requireSignature && (sig == null || expectedSignatureSha256 == null)) tampered = true;
    if (rooted) reasons.add('rooted');
    if (emu) reasons.add('emulator');
    if (hooked) reasons.add('hooking_framework');
    if (dbg) reasons.add('debuggable');
    if (tampered) reasons.add('signature_mismatch');
    return IntegrityReport(rooted: rooted, emulator: emu, hooked: hooked, debuggable: dbg, tampered: tampered, reasons: reasons);
  }

  /// Bloquea operaciones sensibles si el entorno no es confiable.
  Future<void> requireTrusted() async {
    final r = await evaluate();
    if (!r.trusted) throw StateError('operación sensible bloqueada: entorno no confiable (${r.reasons.join(', ')})');
  }
}

/// Marca de agua de build (watermark): identificador inyectado en compilación con --dart-define=SW_BUILD_ID=...
class BuildWatermark {
  static const buildId = String.fromEnvironment('SW_BUILD_ID', defaultValue: 'dev-build');
  static const appHash = String.fromEnvironment('SW_APP_HASH', defaultValue: 'dev-hash');
}
