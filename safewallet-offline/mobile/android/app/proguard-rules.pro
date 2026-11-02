# SafeWallet Offline — reglas R8/ProGuard (ofuscación agresiva; se conserva solo lo que Flutter necesita)
-repackageclasses ''
-allowaccessmodification
-keep class io.flutter.app.** { *; }
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.util.** { *; }
-keep class io.flutter.view.** { *; }
-keep class io.flutter.embedding.** { *; }
-dontwarn io.flutter.embedding.**
-dontwarn com.google.android.play.core.**
# Elimina logs en release
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}
