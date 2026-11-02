// REFERENCIA NATIVA (Android) — NO está incluida en la compilación de la app ni fue compilada en este entorno.
// Receptor del kill-switch «SAFE-SOS-<PIN>»: reenvía el SMS al motor Dart (SosSmsHandler.handleIncoming) aunque la app esté cerrada.
// Integración: copiar a android/app/src/main/kotlin/pe/safewallet/safewallet_offline/, declarar el receiver y el permiso RECEIVE_SMS
// en AndroidManifest.xml, y arrancar un FlutterEngine headless que invoque el handler por MethodChannel «pe.safewallet/sos».
package pe.safewallet.safewallet_offline

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel

class SosSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val from = msgs.firstOrNull()?.originatingAddress ?: return
        val body = msgs.joinToString("") { it.messageBody ?: "" }
        if (!Regex("^\\s*SAFE-SOS-\\d{4,8}\\s*$", RegexOption.IGNORE_CASE).matches(body)) return
        val engine = FlutterEngine(context)
        engine.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
        MethodChannel(engine.dartExecutor.binaryMessenger, "pe.safewallet/sos").invokeMethod("sos", mapOf("from" to from, "body" to body))
    }
}
